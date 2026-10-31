using Hangar.Api.Infrastructure;
using Hangar.Api.Realtime;

namespace Hangar.Api.Endpoints;

public static class WatchEndpoints
{
    public static void MapWatchTogether(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/channels/{channelId:guid}/watch").WithTags("Watch together");

        g.MapGet("", async (Guid channelId, HttpContext http, WatchTogetherService svc, CancellationToken ct) =>
            await svc.GetAsync(http.User.UserId(), channelId, ct) is { } s ? Results.Ok(s) : Results.NoContent());

        g.MapPut("", async (Guid channelId, WatchControlRequest req, HttpContext http, WatchTogetherService svc, CancellationToken ct) =>
            Results.Ok(await svc.ControlAsync(http.User.UserId(), channelId, req, ct)));

        g.MapDelete("", async (Guid channelId, HttpContext http, WatchTogetherService svc, CancellationToken ct) =>
        {
            await svc.StopAsync(http.User.UserId(), channelId, ct);
            return Results.NoContent();
        });
    }
}
