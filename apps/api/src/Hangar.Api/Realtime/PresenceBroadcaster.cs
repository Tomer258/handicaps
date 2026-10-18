using Hangar.Core.Channels;
using Hangar.Core.Permissions;
using Hangar.Core.Persistence;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Hangar.Api.Realtime;

/// <summary>Ephemeral fan-out (presence, typing, member updates) to connections of users who share a server.</summary>
public sealed class PresenceBroadcaster(IHubContext<HangarHub> hub, ConnectionRegistry registry, IServiceScopeFactory scopes)
{
    public async Task PublishIfChangedAsync(Guid userId, string before)
    {
        var after = registry.StatusOf(userId);
        if (after == before) return;
        await PublishAsync(userId, after);
    }

    public async Task PublishAsync(Guid userId, string status)
    {
        if (status == "offline") await RecordLastOnlineAsync(userId);
        var targets = await PeersAsync(userId);
        if (targets.Count > 0)
            await hub.Clients.Clients(targets).SendAsync("presenceChanged", new { userId, status });
    }

    public async Task MemberUpdatedAsync(Guid userId, object payload)
    {
        var targets = await PeersAsync(userId);
        targets.AddRange(registry.ForUser(userId).Select(c => c.ConnectionId));
        if (targets.Count > 0)
            await hub.Clients.Clients(targets.Distinct().ToList()).SendAsync("memberUpdated", payload);
    }

    /// <summary>Someone joined: members reload their roster (the payload names only the server).</summary>
    public async Task MembersChangedAsync(Guid userId, Guid serverId)
    {
        var targets = await PeersAsync(userId);
        if (targets.Count > 0)
            await hub.Clients.Clients(targets).SendAsync("membersChanged", new { serverId });
    }

    public async Task TypingAsync(Channel channel, Guid userId, string fromConnection)
    {
        using var scope = scopes.CreateScope();
        var permissions = scope.ServiceProvider.GetRequiredService<PermissionService>();
        var targets = new List<string>();
        foreach (var c in registry.SubscribedTo(channel.Id))
        {
            if (c.UserId == userId) continue;
            var mask = await permissions.ChannelPermissionsAsync(c.UserId, channel, CancellationToken.None);
            if (mask.HasFlag(Permission.ViewChannel)) targets.Add(c.ConnectionId);
        }
        if (targets.Count > 0)
            await hub.Clients.Clients(targets).SendAsync("typingChanged", new { channelId = channel.Id, userId });
    }

    private async Task RecordLastOnlineAsync(Guid userId)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HangarDbContext>();
        var now = scope.ServiceProvider.GetRequiredService<TimeProvider>().GetUtcNow();
        await db.Users.Where(u => u.Id == userId).ExecuteUpdateAsync(s => s.SetProperty(u => u.LastOnlineAt, now));
    }

    /// <summary>Connections of every active member of any server this user belongs to.</summary>
    private async Task<List<string>> PeersAsync(Guid userId)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HangarDbContext>();
        var servers = db.ServerMembers.Where(m => m.UserId == userId && m.RemovedAt == null).Select(m => m.ServerId);
        var peers = await db.ServerMembers.AsNoTracking()
            .Where(m => servers.Contains(m.ServerId) && m.RemovedAt == null)
            .Select(m => m.UserId).Distinct().ToListAsync();
        var set = peers.ToHashSet();
        return registry.All().Where(c => set.Contains(c.UserId)).Select(c => c.ConnectionId).ToList();
    }
}
