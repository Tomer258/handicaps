using System.Collections.Concurrent;
using Hangar.Api.Infrastructure;
using Hangar.Core.Channels;
using Hangar.Core.Common;
using Hangar.Core.Media;
using Hangar.Core.Permissions;
using Hangar.Core.Persistence;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Hangar.Api.Realtime;

/// <summary>
/// The shared YouTube player of a voice channel. <see cref="Position"/> is the playback time at <see cref="UpdatedAt"/>;
/// clients add the elapsed time while playing, using <see cref="ServerNow"/> to correct their clock.
/// </summary>
public sealed record WatchStateDto(
    Guid ServerId, Guid ChannelId, string VideoId, string? Title, bool Playing, double Position, DateTimeOffset UpdatedAt,
    long Version, Guid StartedBy, Guid ControlledBy, DateTimeOffset ServerNow);

/// <summary>Start (url) or control (playing / position) the channel's player.</summary>
public sealed record WatchControlRequest(string? Url, bool? Playing, double? Position);

/// <summary>Current players by voice channel; in-process like the rest of the realtime state (single API replica).</summary>
public sealed class WatchTogetherStore
{
    public ConcurrentDictionary<Guid, WatchStateDto> Channels { get; } = new();
    public Lock Gate { get; } = new();
    private long _version;
    public long NextVersion() => Interlocked.Increment(ref _version);
}

/// <summary>
/// Watch together: anyone in the call starts a YouTube video and anyone in the call controls it (like Discord's
/// activity). Everyone who can see the channel gets the state through the hub; it ends when the call empties.
/// </summary>
public sealed class WatchTogetherService(
    HangarDbContext db,
    PermissionService permissions,
    ConnectionRegistry registry,
    IHubContext<HangarHub> hub,
    WatchTogetherStore store,
    LinkPreviewService previews,
    TimeProvider clock)
{
    private const double MaxPosition = 24 * 3600;

    public async Task<WatchStateDto?> GetAsync(Guid userId, Guid channelId, CancellationToken ct)
    {
        var channel = await VoiceChannelAsync(channelId, ct);
        var mask = await permissions.ChannelPermissionsAsync(userId, channel, ct);
        if (!mask.HasFlag(Permission.ViewChannel)) throw AppProblem.NotFound("channel.not_found", "Channel not found.");
        return store.Channels.TryGetValue(channelId, out var s) ? s with { ServerNow = clock.GetUtcNow() } : null;
    }

    public async Task<WatchStateDto> ControlAsync(Guid userId, Guid channelId, WatchControlRequest req, CancellationToken ct)
    {
        var channel = await VoiceChannelAsync(channelId, ct);
        await RequireInCallAsync(userId, channelId, ct);
        if (req.Position is { } p && (!double.IsFinite(p) || p < 0 || p > MaxPosition))
            throw AppProblem.BadRequest("watch.position", "That position is out of range.");

        string? videoId = null, title = null;
        if (req.Url is not null)
        {
            var url = LinkPreviewService.Normalize(req.Url);
            videoId = url is null ? null : LinkPreviewService.YoutubeId(new Uri(url));
            if (videoId is null) throw AppProblem.BadRequest("watch.url", "Paste a YouTube video link.");
            try
            {
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                cts.CancelAfter(TimeSpan.FromSeconds(4));
                title = (await previews.GetAsync($"https://www.youtube.com/watch?v={videoId}", cts.Token))?.Title;
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                /* the title is a nicety */
            }
        }

        WatchStateDto next;
        var now = clock.GetUtcNow();
        lock (store.Gate)
        {
            store.Channels.TryGetValue(channelId, out var cur);
            if (videoId is not null)
                next = new WatchStateDto(channel.ServerId, channelId, videoId, title, req.Playing ?? true, req.Position ?? 0, now,
                    store.NextVersion(), userId, userId, now);
            else
            {
                if (cur is null) throw AppProblem.NotFound("watch.none", "Nothing is playing. Start a video first.");
                var position = req.Position ?? CurrentPosition(cur, now);
                next = cur with
                {
                    Playing = req.Playing ?? cur.Playing, Position = Math.Min(position, MaxPosition), UpdatedAt = now,
                    Version = store.NextVersion(), ControlledBy = userId, ServerNow = now,
                };
            }
            store.Channels[channelId] = next;
        }
        await BroadcastAsync(channel, next, ct);
        return next;
    }

    public async Task StopAsync(Guid userId, Guid channelId, CancellationToken ct)
    {
        var channel = await VoiceChannelAsync(channelId, ct);
        await RequireInCallAsync(userId, channelId, ct);
        if (store.Channels.TryRemove(channelId, out _)) await BroadcastAsync(channel, null, ct);
    }

    /// <summary>Ends players whose call emptied (called by <see cref="WatchTogetherSweeper"/>).</summary>
    public async Task SweepAsync(CancellationToken ct)
    {
        foreach (var channelId in store.Channels.Keys.ToList())
        {
            var occupied = await db.VoiceLeases.AsNoTracking().AnyAsync(l => l.ChannelId == channelId &&
                (l.Status == VoiceLeaseStatus.Active || l.Status == VoiceLeaseStatus.Joining), ct);
            if (occupied || !store.Channels.TryRemove(channelId, out _)) continue;
            var channel = await db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == channelId, ct);
            if (channel is not null) await BroadcastAsync(channel, null, ct);
        }
    }

    private static double CurrentPosition(WatchStateDto s, DateTimeOffset now) =>
        s.Playing ? s.Position + Math.Max(0, (now - s.UpdatedAt).TotalSeconds) : s.Position;

    private async Task<Channel> VoiceChannelAsync(Guid channelId, CancellationToken ct) =>
        await db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == channelId && c.ArchivedAt == null && c.Type == ChannelType.Voice, ct)
        ?? throw AppProblem.NotFound("channel.not_found", "Channel not found.");

    private async Task RequireInCallAsync(Guid userId, Guid channelId, CancellationToken ct)
    {
        var inCall = await db.VoiceLeases.AsNoTracking().AnyAsync(l => l.UserId == userId && l.ChannelId == channelId &&
            (l.Status == VoiceLeaseStatus.Active || l.Status == VoiceLeaseStatus.Joining), ct);
        if (!inCall) throw AppProblem.Forbidden("watch.not_in_call", "Join the voice channel to control what it watches.");
    }

    private async Task BroadcastAsync(Channel channel, WatchStateDto? state, CancellationToken ct)
    {
        var targets = new List<string>();
        foreach (var group in registry.All().GroupBy(c => c.UserId))
        {
            var mask = await permissions.ChannelPermissionsAsync(group.Key, channel, ct);
            if (mask.HasFlag(Permission.ViewChannel)) targets.AddRange(group.Select(c => c.ConnectionId));
        }
        if (targets.Count > 0)
            await hub.Clients.Clients(targets).SendAsync("watchChanged", new { serverId = channel.ServerId, channelId = channel.Id, state }, ct);
    }
}

public sealed class WatchTogetherSweeper(IServiceScopeFactory scopes, WatchTogetherStore store, ILogger<WatchTogetherSweeper> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            if (store.Channels.IsEmpty) continue;
            try
            {
                using var scope = scopes.CreateScope();
                await scope.ServiceProvider.GetRequiredService<WatchTogetherService>().SweepAsync(stoppingToken);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                log.LogWarning(e, "Watch-together sweep failed");
            }
        }
    }
}
