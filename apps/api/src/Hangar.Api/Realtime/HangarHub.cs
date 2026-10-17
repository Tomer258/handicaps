using Hangar.Api.Infrastructure;
using Hangar.Core.Channels;
using Hangar.Core.Permissions;
using Hangar.Core.Persistence;
using Hangar.Core.Users;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Hangar.Api.Realtime;

public sealed record SubscriptionAck(Guid ChannelId, string Cursor, string PolicyVersion);

/// <summary>
/// Application event hub. Commands with durable results use REST; the hub only subscribes, carries typing and
/// presence heartbeats. Each invocation passes <see cref="SessionHubFilter"/>; groups are not used for authorization.
/// </summary>
[Authorize]
public sealed class HangarHub(
    ConnectionRegistry registry,
    PresenceBroadcaster presence,
    PermissionService permissions,
    HangarDbContext db) : Hub
{
    public const string Path = "/hubs/realtime";

    public override async Task OnConnectedAsync()
    {
        var user = Context.User!;
        var info = new ConnectionInfo(Context.ConnectionId, user.UserId(), user.SessionId(), Context.Abort);
        if (!registry.HasPreferred(info.UserId))
        {
            var pref = await db.UserSettings.AsNoTracking().Where(s => s.UserId == info.UserId)
                .Select(s => (PreferredStatus?)s.PreferredStatus).FirstOrDefaultAsync();
            registry.SetPreferred(info.UserId, pref ?? PreferredStatus.Online);
        }
        var before = registry.StatusOf(info.UserId);
        registry.Add(info);
        await presence.PublishIfChangedAsync(info.UserId, before);
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var info = registry.Get(Context.ConnectionId);
        if (info is not null)
        {
            var before = registry.StatusOf(info.UserId);
            registry.Remove(Context.ConnectionId);
            await presence.PublishIfChangedAsync(info.UserId, before);
        }
        await base.OnDisconnectedAsync(exception);
    }

    /// <summary>Authorizes each channel and returns the boundary cursor so the client can fetch deltas after it.</summary>
    public async Task<List<SubscriptionAck>> SubscribeChannels(List<Guid> channelIds)
    {
        var info = registry.Get(Context.ConnectionId) ?? throw new HubException("Not connected.");
        if (channelIds.Count > 200) throw new HubException("Too many channels.");
        var channels = await db.Channels.AsNoTracking().Where(c => channelIds.Contains(c.Id) && c.ArchivedAt == null).ToListAsync();
        var acks = new List<SubscriptionAck>();
        foreach (var c in channels)
        {
            var mask = await permissions.ChannelPermissionsAsync(info.UserId, c, Context.ConnectionAborted);
            if (!mask.HasFlag(Permission.ViewChannel)) continue;
            info.Channels[c.Id] = 0;
            acks.Add(new SubscriptionAck(c.Id, (c.NextEventSequence - 1).ToString(), c.PolicyVersion.ToString()));
        }
        return acks;
    }

    public void UnsubscribeChannel(Guid channelId) => registry.Get(Context.ConnectionId)?.Channels.TryRemove(channelId, out _);

    public async Task Typing(Guid channelId)
    {
        var info = registry.Get(Context.ConnectionId);
        if (info is null || !info.Channels.ContainsKey(channelId)) return;
        var channel = await db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == channelId);
        if (channel is null || channel.Type != ChannelType.Text) return;
        var mask = await permissions.ChannelPermissionsAsync(info.UserId, channel, Context.ConnectionAborted);
        if (!mask.HasFlag(Permission.SendMessages)) return;
        await presence.TypingAsync(channel, info.UserId, Context.ConnectionId);
    }

    /// <summary>Client heartbeat every ~25 s; idle = no interaction for 5 minutes (approximate, browser-only signal).</summary>
    public async Task PresenceHeartbeat(bool idle)
    {
        var info = registry.Get(Context.ConnectionId);
        if (info is null) return;
        var before = registry.StatusOf(info.UserId);
        info.LastHeartbeat = DateTimeOffset.UtcNow;
        info.Idle = idle;
        await presence.PublishIfChangedAsync(info.UserId, before);
    }

    public Dictionary<Guid, string> GetPresence() => registry.Snapshot();
}
