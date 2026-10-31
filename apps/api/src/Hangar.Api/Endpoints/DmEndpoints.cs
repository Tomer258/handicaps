using Hangar.Api.Infrastructure;
using Hangar.Core.Channels;

namespace Hangar.Api.Endpoints;

public static class DmEndpoints
{
    public static void MapDirectMessages(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("").WithTags("Direct messages");

        // One person → that conversation (opened once per pair); several → a new group.
        g.MapPost("/servers/{serverId:guid}/dms", async (Guid serverId, OpenDmRequest req, HttpContext http, DmService svc, CancellationToken ct) =>
            Results.Ok(await svc.OpenAsync(http.User.UserId(), serverId, req, ct)));

        g.MapPost("/channels/{channelId:guid}/members", async (Guid channelId, DmMembersRequest req, HttpContext http, DmService svc, CancellationToken ct) =>
            Results.Ok(await svc.AddMembersAsync(http.User.UserId(), channelId, req, ct)));

        g.MapDelete("/channels/{channelId:guid}/members/me", async (Guid channelId, HttpContext http, DmService svc, CancellationToken ct) =>
        {
            await svc.LeaveAsync(http.User.UserId(), channelId, ct);
            return Results.NoContent();
        });

        g.MapPatch("/channels/{channelId:guid}/group", async (Guid channelId, RenameGroupRequest req, HttpContext http, DmService svc, CancellationToken ct) =>
            Results.Ok(await svc.RenameAsync(http.User.UserId(), channelId, req, ct)));
    }
}
