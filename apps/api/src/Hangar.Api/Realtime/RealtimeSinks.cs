using Hangar.Core.Identity;
using Hangar.Core.Persistence;
using Hangar.Core.Users;
using Hangar.Core.Workspaces;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Hangar.Api.Realtime;

/// <summary>Server name/icon/settings changed → every connected member refetches the server.</summary>
public sealed class SignalRServerSink(IHubContext<HangarHub> hub, ConnectionRegistry registry, HangarDbContext db) : IServerChangeSink
{
    public async Task ServerUpdatedAsync(Guid serverId, CancellationToken ct)
    {
        var members = (await db.ServerMembers.AsNoTracking().Where(m => m.ServerId == serverId && m.RemovedAt == null)
            .Select(m => m.UserId).ToListAsync(ct)).ToHashSet();
        var conns = registry.All().Where(c => members.Contains(c.UserId)).Select(c => c.ConnectionId).ToList();
        if (conns.Count > 0) await hub.Clients.Clients(conns).SendAsync("serverUpdated", new { serverId }, ct);
    }
}

/// <summary>Policy change → tell affected clients to refetch server detail and resubscribe.</summary>
public sealed class SignalRPolicySink(IHubContext<HangarHub> hub, ConnectionRegistry registry) : IPolicyChangeSink
{
    public async Task PolicyChangedAsync(Guid serverId, long policyVersion, IReadOnlyCollection<Guid>? affectedUsers, CancellationToken ct)
    {
        var conns = registry.All().Where(c => affectedUsers is null || affectedUsers.Contains(c.UserId)).ToList();
        // Drop channel subscriptions: the client rebuilds them from a fresh, authorized snapshot.
        foreach (var c in conns) c.Channels.Clear();
        if (conns.Count > 0)
            await hub.Clients.Clients(conns.Select(c => c.ConnectionId).ToList())
                .SendAsync("policyChanged", new { serverId, policyVersion = policyVersion.ToString() }, ct);
    }
}

public sealed class SignalRProfileSink(PresenceBroadcaster broadcaster, ConnectionRegistry registry, HangarDbContext db) : IProfileChangeSink
{
    public async Task ProfileChangedAsync(Guid userId, CancellationToken ct)
    {
        var row = await db.Users.AsNoTracking().Where(u => u.Id == userId)
            .Join(db.UserSettings, u => u.Id, s => s.UserId, (u, s) => new { u.DisplayName, u.AvatarHue, u.AvatarAssetId, s.PreferredStatus })
            .FirstOrDefaultAsync(ct);
        if (row is null) return;
        var before = registry.StatusOf(userId);
        registry.SetPreferred(userId, row.PreferredStatus);
        await broadcaster.MemberUpdatedAsync(userId, new { userId, row.DisplayName, row.AvatarHue, row.AvatarAssetId });
        await broadcaster.PublishIfChangedAsync(userId, before);
    }
}

/// <summary>
/// Session revocation: suppress delivery immediately, tell the browser, then abort the socket server-side.
/// Does not rely on the client cooperating with the SessionRevoked event.
/// </summary>
public sealed class RealtimeRevocationListener(IHubContext<HangarHub> hub, ConnectionRegistry registry, PresenceBroadcaster presence)
    : ISessionRevocationListener
{
    public async Task OnSessionsRevokedAsync(Guid userId, IReadOnlyCollection<Guid> sessionIds, string reason, CancellationToken ct)
    {
        var before = registry.StatusOf(userId);
        var conns = registry.ForSessions(sessionIds);
        foreach (var c in conns) c.Revoked = true;
        if (conns.Count > 0)
            await hub.Clients.Clients(conns.Select(c => c.ConnectionId).ToList()).SendAsync("sessionRevoked", new { reason }, ct);
        foreach (var c in conns)
        {
            c.Abort();
            registry.Remove(c.ConnectionId);
        }
        await presence.PublishIfChangedAsync(userId, before);
    }
}

/// <summary>Sweeps connections that stopped heart-beating (75 s) so presence never sticks on a dead socket.</summary>
public sealed class PresenceSweeper(ConnectionRegistry registry, PresenceBroadcaster presence) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            foreach (var c in registry.Expired(TimeSpan.FromSeconds(75)))
            {
                var before = registry.StatusOf(c.UserId);
                c.Abort();
                registry.Remove(c.ConnectionId);
                await presence.PublishIfChangedAsync(c.UserId, before);
            }
        }
    }
}
