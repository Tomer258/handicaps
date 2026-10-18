using System.Collections.Concurrent;
using Hangar.Core.Common;
using Hangar.Core.Media;
using Hangar.Core.Permissions;
using Hangar.Core.Persistence;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Hangar.Api.Realtime;

public sealed record VoicePingResult(int Notified);

/// <summary>
/// "Ping online friends" (States 02): someone sitting in voice invites the members who are online, can join that
/// channel and aren't in it yet. One ping per person per channel every two minutes; Do-not-disturb is respected.
/// </summary>
public sealed class VoicePingService(
    HangarDbContext db,
    PermissionService permissions,
    ConnectionRegistry registry,
    IHubContext<HangarHub> hub,
    VoicePingCooldowns cooldowns,
    TimeProvider clock)
{
    public static readonly TimeSpan Cooldown = TimeSpan.FromMinutes(2);

    public async Task<VoicePingResult> PingAsync(Guid userId, Guid leaseId, CancellationToken ct)
    {
        var lease = await db.VoiceLeases.AsNoTracking().FirstOrDefaultAsync(l => l.Id == leaseId && l.UserId == userId &&
            (l.Status == VoiceLeaseStatus.Active || l.Status == VoiceLeaseStatus.Joining), ct)
            ?? throw AppProblem.NotFound("voice.lease_not_found", "Join the voice channel first.");
        var channel = await db.Channels.AsNoTracking().FirstAsync(c => c.Id == lease.ChannelId, ct);

        var now = clock.GetUtcNow();
        var key = (userId, channel.Id);
        if (cooldowns.Last.TryGetValue(key, out var last) && now - last < Cooldown)
            throw AppProblem.TooMany("voice.ping_cooldown", "You pinged everyone a moment ago.", Cooldown - (now - last));

        var inChannel = await db.VoiceLeases.AsNoTracking()
            .Where(l => l.ChannelId == channel.Id && (l.Status == VoiceLeaseStatus.Active || l.Status == VoiceLeaseStatus.Joining))
            .Select(l => l.UserId).ToListAsync(ct);
        var members = await db.ServerMembers.AsNoTracking()
            .Where(m => m.ServerId == channel.ServerId && m.RemovedAt == null && m.UserId != userId)
            .Select(m => m.UserId).ToListAsync(ct);
        var recipients = new List<Guid>();
        foreach (var uid in members.Except(inChannel))
        {
            var status = registry.StatusOf(uid);
            if (status is "offline" or "dnd") continue;
            var mask = await permissions.ChannelPermissionsAsync(uid, channel, ct);
            if (mask.HasFlag(Permission.ViewChannel) && mask.HasFlag(Permission.JoinVoice)) recipients.Add(uid);
        }

        cooldowns.Last[key] = now;
        var fromName = await db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => u.DisplayName).FirstAsync(ct);
        var connections = recipients.SelectMany(registry.ForUser).Select(c => c.ConnectionId).ToList();
        if (connections.Count > 0)
            await hub.Clients.Clients(connections).SendAsync("voicePing", new
            {
                serverId = channel.ServerId, channelId = channel.Id, channelName = channel.Name, fromUserId = userId, fromDisplayName = fromName,
            }, ct);
        return new VoicePingResult(recipients.Count);
    }
}

/// <summary>Last ping per (user, channel); in-process like the rest of the realtime state (single API replica).</summary>
public sealed class VoicePingCooldowns
{
    public ConcurrentDictionary<(Guid UserId, Guid ChannelId), DateTimeOffset> Last { get; } = new();
}
