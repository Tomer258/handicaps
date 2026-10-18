using Hangar.Api.Infrastructure;
using Hangar.Core.Media;
using Microsoft.Extensions.Options;

namespace Hangar.Api.Endpoints;

public static class VoiceEndpoints
{
    public static void MapVoice(this RouteGroupBuilder api)
    {
        api.MapPost("/channels/{channelId:guid}/voice/join", async (Guid channelId, VoiceJoinRequest req, HttpContext http, VoiceService svc, CancellationToken ct) =>
            Results.Ok(await svc.JoinAsync(http.User.UserId(), http.User.SessionId(), channelId, req, ct))).WithTags("Voice");

        var voice = api.MapGroup("/voice").WithTags("Voice");
        voice.MapPost("/{leaseId:guid}/token", async (Guid leaseId, HttpContext http, VoiceService svc, CancellationToken ct) =>
            Results.Ok(await svc.RefreshTokenAsync(http.User.UserId(), http.User.SessionId(), leaseId, ct)));
        voice.MapPost("/{leaseId:guid}/confirm", async (Guid leaseId, HttpContext http, VoiceService svc, CancellationToken ct) =>
        {
            await svc.ConfirmAsync(http.User.UserId(), leaseId, ct);
            return Results.NoContent();
        });
        voice.MapDelete("/{leaseId:guid}", async (Guid leaseId, HttpContext http, VoiceService svc, CancellationToken ct) =>
        {
            await svc.LeaveAsync(http.User.UserId(), leaseId, ct);
            return Results.NoContent();
        });

        voice.MapPost("/{leaseId:guid}/publications/{kind}", async (Guid leaseId, string kind, PublicationRequest? req, HttpContext http, VoiceService svc, CancellationToken ct) =>
            Results.Ok(await svc.ReservePublicationAsync(http.User.UserId(), http.User.SessionId(), leaseId, ParseKind(kind), req ?? new PublicationRequest(null, false), ct)));
        voice.MapDelete("/{leaseId:guid}/publications/{kind}", async (Guid leaseId, string kind, HttpContext http, VoiceService svc, CancellationToken ct) =>
        {
            await svc.ReleasePublicationAsync(http.User.UserId(), leaseId, ParseKind(kind), ct);
            return Results.NoContent();
        });

        api.MapGet("/servers/{serverId:guid}/voice", async (Guid serverId, HttpContext http, VoiceService svc, CancellationToken ct) =>
            Results.Ok(await svc.ListAsync(http.User.UserId(), serverId, ct))).WithTags("Voice");

        api.MapPut("/servers/{serverId:guid}/members/{userId:guid}/voice/mute", async (Guid serverId, Guid userId, ServerMuteRequest req,
            HttpContext http, VoiceService svc, CancellationToken ct) =>
        {
            await svc.SetServerMuteAsync(http.User.UserId(), serverId, userId, req.Muted, ct);
            return Results.NoContent();
        }).WithTags("Voice");
        api.MapDelete("/servers/{serverId:guid}/members/{userId:guid}/voice", async (Guid serverId, Guid userId, HttpContext http, VoiceService svc, CancellationToken ct) =>
        {
            await svc.DisconnectAsync(http.User.UserId(), serverId, userId, ct);
            return Results.NoContent();
        }).WithTags("Voice");
    }

    public sealed record ServerMuteRequest(bool Muted);

    /// <summary>
    /// Service-to-service routes, outside /api/v1 (no cookie/CSRF). The edge must not expose /internal publicly:
    /// LiveKit calls the webhook on the private network; Caddy calls admission as forward_auth for /rtc.
    /// </summary>
    public static void MapLiveKitInternal(this WebApplication app)
    {
        var group = app.MapGroup("/internal/livekit").AllowAnonymous().ExcludeFromDescription();

        group.MapPost("/webhook", async (HttpContext http, VoiceService svc, CancellationToken ct) =>
        {
            // Bounded before buffering (Kestrel's default would accept ~30 MB into memory); oversize → 413.
            if (http.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
                limit.MaxRequestBodySize = 64 * 1024;
            using var ms = new MemoryStream();
            await http.Request.Body.CopyToAsync(ms, ct);
            var ok = await svc.HandleWebhookAsync(http.Request.Headers.Authorization.ToString(), ms.ToArray(), ct);
            return ok ? Results.Ok() : Results.Unauthorized();
        });

        group.MapGet("/admission", async (HttpContext http, VoiceService svc, IOptions<HangarOptions> opt, CancellationToken ct) =>
        {
            // forward_auth: the original URI arrives in X-Forwarded-Uri; browsers pass the token as access_token.
            var origin = http.Request.Headers.Origin.ToString();
            if (origin.Length > 0 && !opt.Value.AllowedOrigins.Contains(origin, StringComparer.OrdinalIgnoreCase)) return Results.StatusCode(403);
            var token = TokenFrom(http);
            return token is not null && await svc.AdmitAsync(token, ct) ? Results.Ok() : Results.StatusCode(403);
        });

        // Polled by the host-local authorization watchdog; it treats 503 and "unreachable" alike.
        app.MapGet("/internal/watchdog/reconcile", (ReconcileHealth health) =>
        {
            var s = health.Status();
            return Results.Json(new { healthy = s.Healthy, fresh = s.Fresh, lastSuccessAt = s.LastSuccessAt, lastAttemptAt = s.LastAttemptAt },
                statusCode: s.Healthy ? 200 : 503);
        }).AllowAnonymous().ExcludeFromDescription();
    }

    private static PublicationKind ParseKind(string kind) => kind switch
    {
        "camera" => PublicationKind.Camera,
        "screen" => PublicationKind.Screen,
        _ => throw Hangar.Core.Common.AppProblem.NotFound("media.kind", "Unknown publication kind."),
    };

    private static string? TokenFrom(HttpContext http)
    {
        var auth = http.Request.Headers.Authorization.ToString();
        if (auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return auth[7..];
        var uri = http.Request.Headers["X-Forwarded-Uri"].ToString();
        var q = uri.IndexOf('?');
        var query = q >= 0 ? uri[(q + 1)..] : (http.Request.QueryString.Value ?? "").TrimStart('?');
        foreach (var part in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var kv = part.Split('=', 2);
            if (kv.Length == 2 && kv[0] == "access_token") return Uri.UnescapeDataString(kv[1]);
        }
        return null;
    }
}
