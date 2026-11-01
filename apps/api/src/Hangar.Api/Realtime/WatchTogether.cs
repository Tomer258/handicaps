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

/// <summary>One video in the player's list; <see cref="Short"/> = a YouTube Short (vertical, shown 9:16).</summary>
public sealed record WatchItem(string VideoId, string? Title, bool Short);

/// <summary>
/// The shared YouTube player of a voice channel. <see cref="Position"/> is the playback time at <see cref="UpdatedAt"/>;
/// clients add the elapsed time while playing, using <see cref="ServerNow"/> to correct their clock. <see cref="Queue"/>
/// is the shared list (pasted together or added later, like a Shorts feed) and <see cref="Index"/> the item playing;
/// <see cref="VideoId"/>/<see cref="Title"/> repeat that item.
/// </summary>
public sealed record WatchStateDto(
    Guid ServerId, Guid ChannelId, string VideoId, string? Title, bool Playing, double Position, DateTimeOffset UpdatedAt,
    long Version, Guid StartedBy, Guid ControlledBy, DateTimeOffset ServerNow, IReadOnlyList<WatchItem> Queue, int Index);

/// <summary>
/// Start (url: one or more links, replaces the list), add (links appended), jump (index; with fromIndex only if that
/// item is still the current one, so several players reporting the same "ended" advance once) or control
/// (playing / position) the channel's player.
/// </summary>
public sealed record WatchControlRequest(string? Url, bool? Playing, double? Position, string? Add = null, int? Index = null, int? FromIndex = null);

/// <summary>Current players by voice channel; in-process like the rest of the realtime state (single API replica).</summary>
public sealed class WatchTogetherStore
{
    public ConcurrentDictionary<Guid, WatchStateDto> Channels { get; } = new();
    public Lock Gate { get; } = new();
    private long _version;
    public long NextVersion() => Interlocked.Increment(ref _version);
}

/// <summary>
/// Watch together: anyone in the call starts a YouTube video and anyone in the call controls it.
/// Everyone who can see the channel gets the state through the hub; it ends when the call empties.
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
    public const int MaxQueue = 50;

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

        var started = req.Url is null ? null : await ItemsAsync(req.Url, ct);
        var added = req.Add is null ? null : await ItemsAsync(req.Add, ct);

        WatchStateDto next;
        var now = clock.GetUtcNow();
        lock (store.Gate)
        {
            store.Channels.TryGetValue(channelId, out var cur);
            if (started is not null)
                next = new WatchStateDto(channel.ServerId, channelId, started[0].VideoId, started[0].Title, req.Playing ?? true, req.Position ?? 0, now,
                    store.NextVersion(), userId, userId, now, started, 0);
            else
            {
                if (cur is null) throw AppProblem.NotFound("watch.none", "Nothing is playing. Start a video first.");
                // Someone else already moved on from the item this request was about: nothing to do.
                if (req.FromIndex is { } from && from != cur.Index) return cur with { ServerNow = now };
                var queue = cur.Queue;
                if (added is not null)
                {
                    if (queue.Count + added.Count > MaxQueue)
                        throw AppProblem.BadRequest("watch.queue_full", $"The list holds up to {MaxQueue} videos.");
                    queue = [.. queue, .. added];
                }
                if (req.Index is { } index)
                {
                    if (index < 0 || index >= queue.Count) throw AppProblem.BadRequest("watch.index", "There is no video there.");
                    next = cur with
                    {
                        VideoId = queue[index].VideoId, Title = queue[index].Title, Queue = queue, Index = index,
                        Playing = req.Playing ?? true, Position = Math.Min(req.Position ?? 0, MaxPosition), UpdatedAt = now,
                        Version = store.NextVersion(), ControlledBy = userId, ServerNow = now,
                    };
                }
                else
                {
                    var position = req.Position ?? CurrentPosition(cur, now);
                    next = cur with
                    {
                        Queue = queue, Playing = req.Playing ?? cur.Playing, Position = Math.Min(position, MaxPosition), UpdatedAt = now,
                        Version = store.NextVersion(), ControlledBy = userId, ServerNow = now,
                    };
                }
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

    /// <summary>Every link in <paramref name="text"/> (separated by spaces, commas or new lines) as a list item, with titles.</summary>
    private async Task<List<WatchItem>> ItemsAsync(string text, CancellationToken ct)
    {
        var links = text.Split([' ', '\n', '\r', '\t', ','], StringSplitOptions.RemoveEmptyEntries);
        if (links.Length == 0) throw AppProblem.BadRequest("watch.url", "Paste a YouTube video link.");
        if (links.Length > MaxQueue) throw AppProblem.BadRequest("watch.queue_full", $"The list holds up to {MaxQueue} videos.");
        var parsed = new List<(string Id, bool Short)>();
        foreach (var link in links)
        {
            var url = LinkPreviewService.Normalize(link);
            var uri = url is null ? null : new Uri(url);
            var id = uri is null ? null : LinkPreviewService.YoutubeId(uri);
            if (id is null)
                throw AppProblem.BadRequest("watch.url", links.Length == 1 ? "Paste a YouTube video link." : $"\"{Shorten(link)}\" is not a YouTube video link.");
            parsed.Add((id, uri!.AbsolutePath.StartsWith("/shorts/", StringComparison.OrdinalIgnoreCase)));
        }
        // Titles are a nicety: fetched together, at most 4 s for the whole list.
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(4));
        var titles = await Task.WhenAll(parsed.Select(async p =>
        {
            try
            {
                return (await previews.GetAsync($"https://www.youtube.com/watch?v={p.Id}", cts.Token))?.Title;
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                return null;
            }
        }));
        return [.. parsed.Select((p, i) => new WatchItem(p.Id, titles[i], p.Short))];
    }

    private static string Shorten(string s) => s.Length <= 40 ? s : s[..37] + "...";

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
