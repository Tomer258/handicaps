using System.Net.Http.Json;
using System.Text.Json;
using Hangar.Core.Common;
using Hangar.Core.Files;
using Hangar.Core.Media;
using Hangar.Core.Permissions;
using Hangar.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Hangar.Core.Soundboard;

public sealed record SoundPlayRequest(Guid RequestId, Guid VoiceLeaseId, Guid SoundId);

public sealed record SoundPlaybackDto(
    Guid PlaybackId, Guid ServerId, Guid ChannelId, Guid SoundId, Guid ActorUserId, string State, int DurationMs,
    DateTimeOffset AcceptedAt, DateTimeOffset? StartedAt);

/// <summary>Allowlisted command to the publisher worker. No client-supplied path, URL or room name ever reaches it.</summary>
public sealed record PublisherPlayCommand(
    string PlaybackId, string Room, string Token, string Actor, string File, string Sha256, int DurationMs, DateTimeOffset Deadline);

public sealed record PublisherAck(string State, long Epoch, string? Code);

public sealed record PublisherHealth(long Epoch, IReadOnlyList<string> Active);

public sealed record WorkerEvent(string PlaybackId, long Epoch, string State, string? Code);

public interface ISoundPublisher
{
    /// <summary>Returns the worker's acknowledgement, or null when the worker is unreachable/ambiguous.</summary>
    Task<PublisherAck?> PlayAsync(PublisherPlayCommand command, CancellationToken ct);
    Task StopAsync(string playbackId, CancellationToken ct);
    Task<PublisherHealth?> HealthAsync(CancellationToken ct);
}

/// <summary>HTTP client for the private publisher endpoint (loopback / private network only, shared key).</summary>
public sealed class HttpSoundPublisher(HttpClient http, IOptions<SoundboardOptions> options, ILogger<HttpSoundPublisher> log) : ISoundPublisher
{
    private HttpRequestMessage Request(HttpMethod method, string path, object? body = null)
    {
        var req = new HttpRequestMessage(method, new Uri(new Uri(options.Value.PublisherUrl), path));
        req.Headers.Add("X-Hangar-Worker-Key", options.Value.WorkerKey);
        if (body is not null) req.Content = JsonContent.Create(body, options: JsonSerializerOptions.Web);
        return req;
    }

    public async Task<PublisherAck?> PlayAsync(PublisherPlayCommand command, CancellationToken ct)
    {
        try
        {
            using var res = await http.SendAsync(Request(HttpMethod.Post, "/play", command), ct);
            if (!res.IsSuccessStatusCode) return new PublisherAck("failed", 0, $"http_{(int)res.StatusCode}");
            return await res.Content.ReadFromJsonAsync<PublisherAck>(JsonSerializerOptions.Web, ct);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException)
        {
            log.LogWarning(e, "Sound publisher play failed");
            return null;
        }
    }

    public async Task StopAsync(string playbackId, CancellationToken ct)
    {
        try
        {
            using var res = await http.SendAsync(Request(HttpMethod.Post, "/stop", new { playbackId }), ct);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            log.LogWarning(e, "Sound publisher stop failed");
        }
    }

    public async Task<PublisherHealth?> HealthAsync(CancellationToken ct)
    {
        try
        {
            using var res = await http.SendAsync(Request(HttpMethod.Get, "/health"), ct);
            return res.IsSuccessStatusCode ? await res.Content.ReadFromJsonAsync<PublisherHealth>(JsonSerializerOptions.Web, ct) : null;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException)
        {
            return null;
        }
    }
}

/// <summary>
/// Authoritative room playback (soundboard.md §3): admission and rate limits in one serialized transaction, an
/// allowlisted command to the publisher, worker acknowledgements, stop/stop-all and reconciliation. Ambiguous
/// worker failures are marked failed and never retried, so a sound is missed rather than replayed unexpectedly.
/// </summary>
public sealed class SoundPlaybackService(
    HangarDbContext db,
    PermissionService permissions,
    ISoundPublisher publisher,
    ISoundEventSink events,
    IOptions<SoundboardOptions> options,
    IOptions<LiveKitOptions> liveKit,
    TimeProvider clock,
    ILogger<SoundPlaybackService> log)
{
    private const long PlaybackLockKey = 0x4841_4E47_5342; // "HANGSB"
    private SoundboardOptions O => options.Value;

    public async Task<SoundPlaybackDto> PlayAsync(Guid userId, Guid sessionId, Guid channelId, SoundPlayRequest req, CancellationToken ct)
    {
        if (req.RequestId == Guid.Empty) throw AppProblem.BadRequest("sound.request_id", "requestId is required.");
        var (channel, _) = await permissions.RequireChannelAsync(userId, channelId, Permission.PlaySoundboard, ct);

        var retry = await db.SoundPlaybackCommands.AsNoTracking().FirstOrDefaultAsync(c => c.ActorUserId == userId && c.RequestId == req.RequestId, ct);
        if (retry is not null) return ToDto(retry);

        var lease = await db.VoiceLeases.AsNoTracking().FirstOrDefaultAsync(l => l.Id == req.VoiceLeaseId && l.UserId == userId, ct);
        if (lease is null || lease.SessionId != sessionId || lease.ChannelId != channelId || lease.Status != VoiceLeaseStatus.Active)
            throw AppProblem.Conflict("sound.not_in_voice", "Join this voice channel to play sounds.");

        var sound = await db.SoundboardSounds.AsNoTracking()
            .FirstOrDefaultAsync(s => s.Id == req.SoundId && s.ServerId == channel.ServerId && s.State == SoundState.Ready, ct)
            ?? throw AppProblem.NotFound("sound.not_found", "Sound not found.");
        var version = await db.SoundAssetVersions.AsNoTracking().Where(v => v.Id == sound.ActiveVersionId)
            .Join(db.FileAssets, v => v.FileAssetId, f => f.Id, (v, f) => new { v.Id, v.Sha256, v.DurationMs, f.StorageKey })
            .FirstOrDefaultAsync(ct) ?? throw AppProblem.NotFound("sound.not_found", "Sound not found.");

        var now = clock.GetUtcNow();
        SoundPlaybackCommand cmd;
        List<Guid> expired;
        await using (var tx = await db.Database.BeginTransactionAsync(ct))
        {
            // One serialization point for per-actor, per-room and installation-wide limits.
            await db.Database.ExecuteSqlRawAsync($"SELECT pg_advisory_xact_lock({PlaybackLockKey})", ct);
            expired = await ExpireStaleAsync(now, ct);

            var minute = now.AddMinutes(-1);
            var recent = await db.SoundPlaybackCommands.AsNoTracking()
                .Where(c => c.AcceptedAt > minute && c.State != PlaybackState.Rejected && (c.ActorUserId == userId || c.ChannelId == channelId))
                .Select(c => new { c.ActorUserId, c.ChannelId, c.AcceptedAt }).ToListAsync(ct);
            var mine = recent.Where(c => c.ActorUserId == userId).OrderBy(c => c.AcceptedAt).ToList();
            if (mine.Count > 0 && now - mine[^1].AcceptedAt < O.MinInterval)
                throw AppProblem.TooMany("sound.cooldown", "Slow down — wait a moment between sounds.", mine[^1].AcceptedAt + O.MinInterval - now);
            if (mine.Count >= O.PerUserPerMinute)
                throw AppProblem.TooMany("sound.rate_user", "You've played a lot of sounds — take a short break.", mine[^O.PerUserPerMinute].AcceptedAt.AddMinutes(1) - now);
            var room = recent.Where(c => c.ChannelId == channelId).OrderBy(c => c.AcceptedAt).ToList();
            if (room.Count >= O.PerRoomPerMinute)
                throw AppProblem.TooMany("sound.rate_room", "This channel is playing too many sounds. Try again soon.", room[^O.PerRoomPerMinute].AcceptedAt.AddMinutes(1) - now);

            var active = await db.SoundPlaybackCommands.AsNoTracking()
                .Where(c => c.State == PlaybackState.Accepted || c.State == PlaybackState.Starting || c.State == PlaybackState.Playing)
                .Select(c => c.ActorUserId).ToListAsync(ct);
            if (active.Contains(userId)) throw AppProblem.Conflict("sound.busy_actor", "Your sound is still playing.");
            if (active.Count >= O.MaxActiveInstallation) throw AppProblem.Conflict("sound.busy", "Two sounds are already playing. Try again in a moment.");

            cmd = new SoundPlaybackCommand
            {
                Id = Guid.CreateVersion7(), RequestId = req.RequestId, ServerId = channel.ServerId, ChannelId = channelId, RoomName = lease.RoomName,
                RoomGeneration = lease.RoomGeneration, VoiceLeaseId = lease.Id, ActorUserId = userId, SoundId = sound.Id, SoundVersionId = version.Id,
                State = PlaybackState.Starting, DurationMs = version.DurationMs, AcceptedAt = now, StartDeadline = now + O.StartDeadline,
            };
            db.SoundPlaybackCommands.Add(cmd);
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
        }
        foreach (var id in expired) await PublishAsync(id, ct);

        var token = LiveKitTokens.Create(liveKit.Value.ApiKey, liveKit.Value.ApiSecret, VoiceService.PublisherIdentityPrefix + cmd.RoomName,
            O.PublisherTokenLifetime, now, new VideoGrant
            {
                Room = cmd.RoomName, RoomJoin = true, CanPublish = true, CanSubscribe = false, CanPublishData = false, CanUpdateOwnMetadata = false,
            }, "Soundboard");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(O.StartDeadline);
        var ack = await publisher.PlayAsync(new PublisherPlayCommand(
            cmd.Id.ToString(), cmd.RoomName, token, userId.ToString(), $"{StorageArea.Sounds}/{version.StorageKey}", version.Sha256,
            version.DurationMs, cmd.StartDeadline), deadline.Token);

        if (ack is { State: "playing" })
        {
            if (await TransitionAsync(cmd.Id, [PlaybackState.Starting], PlaybackState.Playing, ack.Epoch, null, null, ct))
                return await PublishAsync(cmd.Id, ct);
            return ToDto(await db.SoundPlaybackCommands.AsNoTracking().FirstAsync(c => c.Id == cmd.Id, ct)); // stopped meanwhile
        }

        // Unreachable, timed out or refused: fail closed and make sure nothing starts late.
        await TransitionAsync(cmd.Id, [PlaybackState.Starting], PlaybackState.Failed, ack?.Epoch ?? 0, null, ack?.Code ?? "worker_unavailable", ct);
        if (ack is null) await publisher.StopAsync(cmd.Id.ToString(), CancellationToken.None);
        await PublishAsync(cmd.Id, ct);
        throw new AppProblem(503, "sound.unavailable", "The soundboard is unavailable right now.");
    }

    public async Task StopAsync(Guid userId, Guid playbackId, CancellationToken ct)
    {
        var cmd = await db.SoundPlaybackCommands.AsNoTracking().FirstOrDefaultAsync(c => c.Id == playbackId, ct)
                  ?? throw AppProblem.NotFound("sound.playback_not_found", "Playback not found.");
        var (_, mask) = await permissions.RequireChannelAsync(userId, cmd.ChannelId, Permission.None, ct);
        if (cmd.ActorUserId != userId && !mask.HasFlag(Permission.StopOthersSounds))
            throw AppProblem.Forbidden("sound.stop_denied", "You can only stop your own sounds.");
        await StopCommandAsync(cmd.Id, userId, "stopped", ct);
    }

    public async Task<int> StopAllAsync(Guid userId, Guid channelId, CancellationToken ct)
    {
        await permissions.RequireChannelAsync(userId, channelId, Permission.StopOthersSounds, ct);
        var ids = await ActiveIdsAsync(c => c.ChannelId == channelId, ct);
        foreach (var id in ids) await StopCommandAsync(id, userId, "stopped", ct);
        return ids.Count;
    }

    public async Task<IReadOnlyList<SoundPlaybackDto>> ActiveAsync(Guid userId, Guid channelId, CancellationToken ct)
    {
        await permissions.RequireChannelAsync(userId, channelId, Permission.None, ct);
        var rows = await db.SoundPlaybackCommands.AsNoTracking()
            .Where(c => c.ChannelId == channelId && (c.State == PlaybackState.Starting || c.State == PlaybackState.Playing))
            .ToListAsync(ct);
        return rows.Select(ToDto).ToList();
    }

    /// <summary>Worker callback: completed / failed / stopped. Events from another worker epoch are ignored.</summary>
    public async Task HandleWorkerEventAsync(WorkerEvent ev, CancellationToken ct)
    {
        if (!Guid.TryParse(ev.PlaybackId, out var id)) return;
        var target = ev.State switch
        {
            "completed" => PlaybackState.Completed,
            "stopped" => PlaybackState.Stopped,
            "failed" => PlaybackState.Failed,
            _ => (PlaybackState?)null,
        };
        if (target is null) return;
        var cmd = await db.SoundPlaybackCommands.AsNoTracking().FirstOrDefaultAsync(c => c.Id == id, ct);
        if (cmd is null || (cmd.WorkerEpoch != 0 && cmd.WorkerEpoch != ev.Epoch)) return;
        if (await TransitionAsync(id, [PlaybackState.Starting, PlaybackState.Playing], target.Value, null, null,
                target == PlaybackState.Failed ? ev.Code ?? "worker_failed" : null, ct))
            await PublishAsync(id, ct);
    }

    /// <summary>
    /// Periodic: expire missed deadlines, complete overdue plays, stop plays whose actor left voice / lost permission /
    /// whose sound was deleted, fail plays lost by a restarted worker, and purge old terminal records.
    /// </summary>
    public async Task ReconcileAsync(CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        foreach (var id in await ExpireStaleAsync(now, ct)) await PublishAsync(id, ct);

        var active = await db.SoundPlaybackCommands.AsNoTracking()
            .Where(c => c.State == PlaybackState.Starting || c.State == PlaybackState.Playing).ToListAsync(ct);
        if (active.Count > 0)
        {
            var health = await publisher.HealthAsync(ct);
            foreach (var cmd in active)
            {
                var leaseLive = await db.VoiceLeases.AnyAsync(l => l.Id == cmd.VoiceLeaseId && l.Status == VoiceLeaseStatus.Active, ct);
                var soundLive = await db.SoundboardSounds.AnyAsync(s => s.Id == cmd.SoundId && s.State == SoundState.Ready, ct);
                var channel = await db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == cmd.ChannelId, ct);
                var allowed = channel is not null && (await permissions.ChannelPermissionsAsync(cmd.ActorUserId, channel, ct)).HasFlag(Permission.PlaySoundboard);
                if (!leaseLive || !soundLive || !allowed)
                {
                    await StopCommandAsync(cmd.Id, null, !leaseLive ? "actor_left" : !soundLive ? "sound_deleted" : "permission", ct);
                    continue;
                }
                if (cmd.State == PlaybackState.Playing && health is not null && (health.Epoch != cmd.WorkerEpoch || !health.Active.Contains(cmd.Id.ToString())))
                {
                    // Worker restarted or already finished without telling us: never replay, just close the record.
                    var target = health.Epoch != cmd.WorkerEpoch ? PlaybackState.Failed : PlaybackState.Completed;
                    if (await TransitionAsync(cmd.Id, [PlaybackState.Playing], target, null, null, target == PlaybackState.Failed ? "worker_restarted" : null, ct))
                        await PublishAsync(cmd.Id, ct);
                }
            }
        }

        var purgeBefore = now - O.CommandRetention;
        await db.SoundPlaybackCommands
            .Where(c => c.AcceptedAt < purgeBefore && c.State != PlaybackState.Accepted && c.State != PlaybackState.Starting && c.State != PlaybackState.Playing)
            .ExecuteDeleteAsync(ct);
    }

    // ---- helpers --------------------------------------------------------------------------------

    private async Task StopCommandAsync(Guid id, Guid? by, string reason, CancellationToken ct)
    {
        if (!await TransitionAsync(id, [PlaybackState.Accepted, PlaybackState.Starting, PlaybackState.Playing], PlaybackState.Stopped, null, by,
                reason == "stopped" ? null : reason, ct)) return;
        await publisher.StopAsync(id.ToString(), ct);
        await PublishAsync(id, ct);
    }

    /// <summary>Completes or expires commands past their deadlines (compare-and-set). Returns the ids it changed.</summary>
    private async Task<List<Guid>> ExpireStaleAsync(DateTimeOffset now, CancellationToken ct)
    {
        var changed = new List<Guid>();
        var rows = await db.SoundPlaybackCommands.AsNoTracking()
            .Where(c => c.State == PlaybackState.Accepted || c.State == PlaybackState.Starting || c.State == PlaybackState.Playing)
            .Select(c => new { c.Id, c.State, c.StartDeadline, c.StartedAt, c.DurationMs }).ToListAsync(ct);
        foreach (var c in rows)
        {
            if (c.State is PlaybackState.Accepted or PlaybackState.Starting && now > c.StartDeadline + TimeSpan.FromSeconds(1))
            {
                if (await TransitionAsync(c.Id, [c.State], PlaybackState.Expired, null, null, "start_deadline", ct)) changed.Add(c.Id);
            }
            else if (c.State == PlaybackState.Playing && c.StartedAt is { } started && now > started.AddMilliseconds(c.DurationMs) + O.CompletionGrace)
            {
                if (await TransitionAsync(c.Id, [PlaybackState.Playing], PlaybackState.Completed, null, null, null, ct)) changed.Add(c.Id);
            }
        }
        return changed;
    }

    private Task<List<Guid>> ActiveIdsAsync(System.Linq.Expressions.Expression<Func<SoundPlaybackCommand, bool>> where, CancellationToken ct) =>
        db.SoundPlaybackCommands.Where(where)
            .Where(c => c.State == PlaybackState.Accepted || c.State == PlaybackState.Starting || c.State == PlaybackState.Playing)
            .Select(c => c.Id).ToListAsync(ct);

    /// <summary>State changes are compare-and-set so racing stop/ack/reconcile paths cannot resurrect a terminal command.</summary>
    private async Task<bool> TransitionAsync(Guid id, PlaybackState[] from, PlaybackState to, long? epoch, Guid? stoppedBy, string? failure, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var terminal = to is not (PlaybackState.Accepted or PlaybackState.Starting or PlaybackState.Playing);
        var n = await db.SoundPlaybackCommands.Where(c => c.Id == id && from.Contains(c.State))
            .ExecuteUpdateAsync(u => u
                .SetProperty(c => c.State, to)
                .SetProperty(c => c.WorkerEpoch, c => epoch ?? c.WorkerEpoch)
                .SetProperty(c => c.StartedAt, c => to == PlaybackState.Playing ? now : c.StartedAt)
                .SetProperty(c => c.EndedAt, c => terminal ? now : c.EndedAt)
                .SetProperty(c => c.StoppedBy, c => stoppedBy ?? c.StoppedBy)
                .SetProperty(c => c.FailureCode, c => failure ?? c.FailureCode), ct);
        if (n == 1) log.LogDebug("Sound playback {Id} → {State}", id, to);
        return n == 1;
    }

    private async Task<SoundPlaybackDto> PublishAsync(Guid id, CancellationToken ct)
    {
        var dto = ToDto(await db.SoundPlaybackCommands.AsNoTracking().FirstAsync(c => c.Id == id, ct));
        await events.PlaybackChangedAsync(dto, ct);
        return dto;
    }

    private static SoundPlaybackDto ToDto(SoundPlaybackCommand c) => new(
        c.Id, c.ServerId, c.ChannelId, c.SoundId, c.ActorUserId, c.State.ToString().ToLowerInvariant(), c.DurationMs, c.AcceptedAt, c.StartedAt);
}
