using Hangar.Api.Infrastructure;
using Hangar.Core.Identity;
using Hangar.Core.Users;
using Hangar.Core.Workspaces;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.Extensions.Options;

namespace Hangar.Api.Endpoints;

public sealed record RegisterRequest(string InviteSecret, string Login, string Password, string DisplayName, bool Remember);
public sealed record LoginRequest(string Login, string Password, bool Remember);
public sealed record InvitePreviewRequest(string Secret);
public sealed record ChangePasswordRequest(string CurrentPassword, string NewPassword);
public sealed record SessionDto(Guid Id, string? DeviceLabel, DateTimeOffset CreatedAt, DateTimeOffset LastSeenAt, bool Current, bool Persistent);
public sealed record MeResponse(ProfileDto User, IReadOnlyList<ServerSummaryDto> Servers, Guid SessionId);

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
                IOptions<HangarOptions> opt, UserService users, WorkspaceService ws, CancellationToken ct) =>
            {
                var result = await svc.RegisterAsync(req.InviteSecret, req.Login, req.Password, req.DisplayName, req.Remember, DeviceLabel(http), ct);
                await SignInAsync(http, result, af, opt.Value);
                return Results.Ok(await Me(result.User.Id, result.Session.Id, users, ws, ct));
            })
            .AllowAnonymous().RequireRateLimiting("auth");

        auth.MapPost("/login", async (LoginRequest req, HttpContext http, AuthService svc, IAntiforgery af,
                IOptions<HangarOptions> opt, UserService users, WorkspaceService ws, CancellationToken ct) =>
            {
                var ip = http.Connection.RemoteIpAddress?.ToString() ?? "unknown";
                var result = await svc.LoginAsync(req.Login, req.Password, req.Remember, DeviceLabel(http), ip, ct);
                await SignInAsync(http, result, af, opt.Value);
                return Results.Ok(await Me(result.User.Id, result.Session.Id, users, ws, ct));
            })
            .AllowAnonymous().RequireRateLimiting("auth");

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
        new(await users.GetProfileAsync(userId, ct), await ws.ListServersAsync(userId, ct), sessionId);

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
