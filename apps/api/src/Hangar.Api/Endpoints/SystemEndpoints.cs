using Hangar.Api.Infrastructure;

namespace Hangar.Api.Endpoints;

public static class SystemEndpoints
{
    public static void MapSystemStatus(this RouteGroupBuilder api)
    {
        // How much the project takes on the machine: process, host, services, database, disk, live usage (Administrator).
        api.MapGet("/servers/{serverId:guid}/system", async (Guid serverId, HttpContext http, SystemStatusService svc, CancellationToken ct) =>
            Results.Ok(await svc.GetAsync(http.User.UserId(), serverId, ct))).WithTags("System");
    }
}
