using Hangar.Api.Infrastructure;
using Hangar.Core.Common;
using Hangar.Core.Identity;
using Hangar.Core.Messaging;
using Hangar.Core.Users;
using Hangar.Core.Workspaces;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.Extensions.Options;

namespace Hangar.Api.Endpoints;

public sealed record RegisterRequest(string InviteSecret, string Login, string Password, string DisplayName, bool Remember);
public sealed record LoginRequest(string Login, string Password, bool Remember);
public sealed record LoginCodeRequest(string Challenge, string Code);
public sealed record TwoFactorRequiredResponse(bool TwoFactorRequired, string Challenge);
public sealed record TwoFactorCodeRequest(string Code);
public sealed record PasswordConfirmRequest(string Password);
public sealed record RecoveryCodesResponse(IReadOnlyList<string> RecoveryCodes);
public sealed record InvitePreviewRequest(string Secret);
public sealed record ChangePasswordRequest(string CurrentPassword, string NewPassword);
public sealed record SessionDto(Guid Id, string? DeviceLabel, DateTimeOffset CreatedAt, DateTimeOffset LastSeenAt, bool Current, bool Persistent);
/// <summary>CanCreateServers: the install owner (see WorkspaceService.IsInstallOwnerAsync).</summary>
public sealed record MeResponse(ProfileDto User, IReadOnlyList<ServerSummaryDto> Servers, Guid SessionId, bool CanCreateServers = false);

public sealed record AcceptInvitationRequest(string Secret);

public static class AuthEndpoints
{
    public static void MapAuth(this RouteGroupBuilder api)
    {
        var auth = api.MapGroup("/auth").WithTags("Auth");

        auth.MapGet("/csrf", (HttpContext http, IAntiforgery af, IOptions<HangarOptions> opt) =>
        {
            XsrfCookie.Issue(http, af, opt.Value);
            return Results.NoContent();
        }).AllowAnonymous();

        auth.MapPost("/invitations/preview", async (InvitePreviewRequest req, InvitationService invites, CancellationToken ct) =>
            Results.Ok(await invites.PreviewAsync(req.Secret, ct)))
            .AllowAnonymous().RequireRateLimiting("auth");

        auth.MapPost("/register", async (RegisterRequest req, HttpContext http, AuthService svc, IAntiforgery af,
                IOptions<HangarOptions> opt, UserService users, WorkspaceService ws, MessageService messages, Hangar.Api.Realtime.PresenceBroadcaster presence, ILogger<RegisterRequest> log,
                CancellationToken ct) =>
            {
                var result = await svc.RegisterAsync(req.InviteSecret, req.Login, req.Password, req.DisplayName, req.Remember, DeviceLabel(http), ct);
                if (result.JoinedServerId is { } joined)
                {
                    // The account exists either way; a missing roster push or welcome message must not fail registration.
                    try
                    {
                        await presence.MembersChangedAsync(result.User.Id, joined);
                        await messages.PostMemberJoinedAsync(result.User.Id, joined, ct);
                    }
                    catch (Exception ex) { log.LogWarning(ex, "welcome message for {UserId} failed", result.User.Id); }
                }
                await SignInAsync(http, result, af, opt.Value);
                return Results.Ok(await Me(result.User.Id, result.Session.Id, users, ws, ct));
            })
            .AllowAnonymous().RequireRateLimiting("auth");

        // Signed in already: join the invitation's hangar with this account.
        auth.MapPost("/invitations/accept", async (AcceptInvitationRequest req, HttpContext http, AuthService svc, UserService users, WorkspaceService ws,
                MessageService messages, Hangar.Api.Realtime.PresenceBroadcaster presence, ILogger<AcceptInvitationRequest> log, CancellationToken ct) =>
            {
                var userId = http.User.UserId();
                var (serverId, joined) = await svc.JoinAsync(userId, req.Secret, ct);
                if (joined)
                    try
                    {
                        await presence.MembersChangedAsync(userId, serverId);
                        await messages.PostMemberJoinedAsync(userId, serverId, ct);
                    }
                    catch (Exception ex) { log.LogWarning(ex, "welcome message for {UserId} failed", userId); }
                return Results.Ok(new { serverId, me = await Me(userId, http.User.SessionId(), users, ws, ct) });
            })
            .RequireRateLimiting("auth");

        auth.MapPost("/login", async (LoginRequest req, HttpContext http, AuthService svc, IAntiforgery af, LoginChallenges challenges,
                IOptions<HangarOptions> opt, UserService users, WorkspaceService ws, CancellationToken ct) =>
            {
                var ip = http.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                var outcome = await svc.LoginAsync(req.Login, req.Password, req.Remember, DeviceLabel(http), ip, ct);
                if (outcome.SignedIn is not { } result)
                    return Results.Ok(new TwoFactorRequiredResponse(true, challenges.Issue(outcome.PendingUserId, outcome.PendingSecurityVersion, req.Remember)));
                await SignInAsync(http, result, af, opt.Value);
                return Results.Ok(await Me(result.User.Id, result.Session.Id, users, ws, ct));
            })
            .AllowAnonymous().RequireRateLimiting("auth");

        auth.MapPost("/login/code", async (LoginCodeRequest req, HttpContext http, AuthService svc, IAntiforgery af, LoginChallenges challenges,
                IOptions<HangarOptions> opt, UserService users, WorkspaceService ws, CancellationToken ct) =>
            {
                var c = challenges.Read(req.Challenge) ?? throw AppProblem.Unauthorized("auth.challenge_expired", "Sign in again.");
                var ip = http.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                var result = await svc.CompleteTwoFactorLoginAsync(c.UserId, c.SecurityVersion, req.Code, c.Remember, DeviceLabel(http), ip, ct);
                await SignInAsync(http, result, af, opt.Value);
                return Results.Ok(await Me(result.User.Id, result.Session.Id, users, ws, ct));
            })
            .AllowAnonymous().RequireRateLimiting("auth");

        var twoFactor = auth.MapGroup("/2fa");
        twoFactor.MapGet("", async (HttpContext http, TwoFactorService tf, CancellationToken ct) =>
            Results.Ok(await tf.StatusAsync(http.User.UserId(), ct)));
        twoFactor.MapPost("/setup", async (HttpContext http, TwoFactorService tf, CancellationToken ct) =>
            Results.Ok(await tf.BeginSetupAsync(http.User.UserId(), ct)));
        twoFactor.MapPost("/enable", async (TwoFactorCodeRequest req, HttpContext http, TwoFactorService tf, CancellationToken ct) =>
            Results.Ok(new RecoveryCodesResponse(await tf.EnableAsync(http.User.UserId(), req.Code, ct)))).RequireRateLimiting("auth");
        twoFactor.MapPost("/disable", async (PasswordConfirmRequest req, HttpContext http, TwoFactorService tf, CancellationToken ct) =>
        {
            await tf.DisableAsync(http.User.UserId(), req.Password, ct);
            return Results.NoContent();
        }).RequireRateLimiting("auth");
        twoFactor.MapPost("/recovery-codes", async (PasswordConfirmRequest req, HttpContext http, TwoFactorService tf, CancellationToken ct) =>
            Results.Ok(new RecoveryCodesResponse(await tf.RegenerateRecoveryCodesAsync(http.User.UserId(), req.Password, ct)))).RequireRateLimiting("auth");

        auth.MapPost("/logout", async (HttpContext http, AuthService svc, IAntiforgery af, IOptions<HangarOptions> opt, CancellationToken ct) =>
        {
            if (http.User.Identity?.IsAuthenticated == true)
                await svc.LogoutAsync(http.User.UserId(), http.User.SessionId(), ct);
            await http.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
            http.User = new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity());
            XsrfCookie.Issue(http, af, opt.Value);
            return Results.NoContent();
        }).AllowAnonymous();

        auth.MapGet("/me", async (HttpContext http, UserService users, WorkspaceService ws, CancellationToken ct) =>
            Results.Ok(await Me(http.User.UserId(), http.User.SessionId(), users, ws, ct)));

        auth.MapGet("/sessions", async (HttpContext http, AuthService svc, CancellationToken ct) =>
        {
            var current = http.User.SessionId();
            var list = await svc.ListSessionsAsync(http.User.UserId(), ct);
            return Results.Ok(list.Select(s => new SessionDto(s.Id, s.DeviceLabel, s.CreatedAt, s.LastSeenAt, s.Id == current, s.Persistent)));
        });

        auth.MapDelete("/sessions/{id:guid}", async (Guid id, HttpContext http, AuthService svc, CancellationToken ct) =>
        {
            await svc.RevokeSessionAsync(http.User.UserId(), id, ct);
            return Results.NoContent();
        });

        auth.MapPost("/password", async (ChangePasswordRequest req, HttpContext http, AuthService svc, CancellationToken ct) =>
        {
            await svc.ChangePasswordAsync(http.User.UserId(), http.User.SessionId(), req.CurrentPassword, req.NewPassword, ct);
            return Results.NoContent();
        }).RequireRateLimiting("auth");
    }

    private static async Task<MeResponse> Me(Guid userId, Guid sessionId, UserService users, WorkspaceService ws, CancellationToken ct) =>
        new(await users.GetProfileAsync(userId, ct), await ws.ListServersAsync(userId, ct), sessionId, await ws.IsInstallOwnerAsync(userId, ct));

    private static async Task SignInAsync(HttpContext http, AuthResult result, IAntiforgery af, HangarOptions opt)
    {
        var principal = CurrentUserExtensions.BuildPrincipal(result.User.Id, result.Session.Id, CookieAuthenticationDefaults.AuthenticationScheme);
        await http.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, principal, new AuthenticationProperties
        {
            IsPersistent = result.Session.Persistent,
            ExpiresUtc = result.Session.Persistent ? result.Session.AbsoluteExpiresAt : null,
            AllowRefresh = false,
        });
        // The antiforgery request token is bound to the identity; issue a new one for the signed-in principal.
        http.User = principal;
        XsrfCookie.Issue(http, af, opt);
    }

    private static string DeviceLabel(HttpContext http)
    {
        var ua = http.Request.Headers.UserAgent.ToString();
        var browser = ua.Contains("Edg/") ? "Edge" : ua.Contains("Chrome/") ? "Chrome" : ua.Contains("Firefox/") ? "Firefox" : ua.Contains("Safari/") ? "Safari" : "Browser";
        var os = ua.Contains("Windows") ? "Windows" : ua.Contains("Mac OS") ? "macOS" : ua.Contains("Android") ? "Android" : ua.Contains("iPhone") ? "iPhone" : ua.Contains("Linux") ? "Linux" : "Unknown OS";
        return $"{browser} on {os}";
    }
}
