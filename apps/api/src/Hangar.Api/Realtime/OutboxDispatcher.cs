using System.Text.Json;
using Hangar.Core.Channels;
using Hangar.Core.Messaging;
using Hangar.Core.Permissions;
using Hangar.Core.Persistence;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Hangar.Api.Realtime;

public sealed class OutboxSignal : IOutboxSignal
{
    private readonly SemaphoreSlim _signal = new(0, 1);

    public void Notify()
    {
        try { _signal.Release(); } catch (SemaphoreFullException) { /* already signalled */ }
    }

    public Task WaitAsync(TimeSpan timeout, CancellationToken ct) => _signal.WaitAsync(timeout, ct);
}

/// <summary>
/// Single dispatcher for committed ChannelEvents. Delivery is at-least-once: the row is marked after broadcasting,
/// so a crash can duplicate an event; clients dedupe by (channel, eventSequence). Recipients are filtered against
/// current permissions at send time — SignalR groups are never trusted for authorization.
/// </summary>
public sealed class OutboxDispatcher(
    OutboxSignal signal,
    IServiceScopeFactory scopes,
    IHubContext<HangarHub> hub,
    ConnectionRegistry registry,
    ILogger<OutboxDispatcher> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var failures = 0;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await signal.WaitAsync(TimeSpan.FromSeconds(1), stoppingToken);
                while (await DispatchBatchAsync(stoppingToken) > 0) { }
                failures = 0;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                failures++;
                log.LogError(ex, "Outbox dispatch failed (attempt {Failures}); HTTP history remains available", failures);
                await Task.Delay(TimeSpan.FromMilliseconds(Math.Min(30_000, 250 * Math.Pow(2, failures))), stoppingToken);
            }
        }
    }

    private async Task<int> DispatchBatchAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HangarDbContext>();
        var permissions = scope.ServiceProvider.GetRequiredService<PermissionService>();

        var batch = await db.ChannelEvents
            .Where(e => e.DispatchedAt == null)
            .OrderBy(e => e.ChannelId).ThenBy(e => e.EventSequence)
            .Take(200).ToListAsync(ct);
        if (batch.Count == 0) return 0;

        var channelIds = batch.Select(e => e.ChannelId).Distinct().ToList();
        var channels = await db.Channels.AsNoTracking().Where(c => channelIds.Contains(c.Id)).ToDictionaryAsync(c => c.Id, ct);
        var canView = new Dictionary<(Guid User, Guid Channel), bool>();

        async Task<bool> Allowed(Guid userId, Channel channel)
        {
            if (!canView.TryGetValue((userId, channel.Id), out var ok))
            {
                ok = (await permissions.ChannelPermissionsAsync(userId, channel, ct)).HasFlag(Permission.ViewChannel);
                canView[(userId, channel.Id)] = ok;
            }
            return ok;
        }

        foreach (var e in batch)
        {
            if (channels.TryGetValue(e.ChannelId, out var channel))
            {
                var envelope = MessageService.ToDto(e);
                var targets = new List<string>();
                foreach (var c in registry.SubscribedTo(e.ChannelId))
                    if (await Allowed(c.UserId, channel)) targets.Add(c.ConnectionId);
                if (targets.Count > 0) await hub.Clients.Clients(targets).SendAsync("channelEvent", envelope, ct);

                if (e.Type == ChannelEventTypes.MessageCreated || e.Type == ChannelEventTypes.MessageUpdated)
                    await NotifyMentionsAsync(e, envelope.Payload, channel, Allowed, ct);
                if (e.Type == ChannelEventTypes.MessageCreated && ChannelTypes.IsDm(channel.Type))
                    await NotifyDirectAsync(db, e, channel, Allowed, ct);
            }
            e.DispatchedAt = DateTimeOffset.UtcNow;
            e.DispatchAttempts++;
        }
        await db.SaveChangesAsync(ct);
        return batch.Count;
    }

    /// <summary>Every new direct message notifies the other participants (type "direct"), mentioned or not.</summary>
    private async Task NotifyDirectAsync(HangarDbContext db, ChannelEvent e, Channel channel, Func<Guid, Channel, Task<bool>> allowed, CancellationToken ct)
    {
        var others = await db.ChannelMembers.AsNoTracking().Where(m => m.ChannelId == channel.Id && m.UserId != e.ActorUserId)
            .Select(m => m.UserId).ToListAsync(ct);
        foreach (var uid in others)
        {
            if (!await allowed(uid, channel)) continue;
            var conns = registry.ForUser(uid).Select(c => c.ConnectionId).ToList();
            if (conns.Count > 0)
                await hub.Clients.Clients(conns).SendAsync("notificationCreated",
                    new { type = "direct", channelId = e.ChannelId, serverId = e.ServerId, messageId = e.EntityId, actorUserId = e.ActorUserId }, ct);
        }
    }

    private async Task NotifyMentionsAsync(ChannelEvent e, JsonElement payload, Channel channel,
        Func<Guid, Channel, Task<bool>> allowed, CancellationToken ct)
    {
        if (!payload.TryGetProperty("mentions", out var mentions) || mentions.ValueKind != JsonValueKind.Array) return;
        foreach (var m in mentions.EnumerateArray())
        {
            if (!m.TryGetGuid(out var uid) || !await allowed(uid, channel)) continue;
            var conns = registry.ForUser(uid).Select(c => c.ConnectionId).ToList();
            if (conns.Count > 0)
                // Text omitted on purpose: the client renders from its own authorized state (no inaccessible names leak).
                await hub.Clients.Clients(conns).SendAsync("notificationCreated",
                    new { type = "mention", channelId = e.ChannelId, serverId = e.ServerId, messageId = e.EntityId, actorUserId = e.ActorUserId }, ct);
        }
    }
}
