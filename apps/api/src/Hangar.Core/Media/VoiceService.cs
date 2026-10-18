using System.Collections.Concurrent;
using System.Text.Json;
using Hangar.Core.Audit;
using Hangar.Core.Channels;
using Hangar.Core.Common;
using Hangar.Core.Identity;
using Hangar.Core.Permissions;
using Hangar.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Hangar.Core.Media;

public sealed record VoiceJoinRequest(Guid RequestId, Guid? PriorLeaseId);

public sealed record VoiceJoinResponse(
    Guid LeaseId, Guid ChannelId, string Url, string Token, DateTimeOffset TokenExpiresAt, bool CanSpeak, bool CanCamera, bool CanScreen);

public sealed record VoiceMemberDto(
    Guid UserId, Guid ChannelId, bool Muted, bool Deafened, bool ServerMuted, bool Camera, bool Screen, DateTimeOffset JoinedAt);

public sealed record VoiceStateUpdate(bool Muted, bool Deafened);

public sealed record PublicationRequest(string? Quality, bool WithAudio);

public sealed record PublicationDto(Guid Id, string Kind, string? Quality, bool WithAudio, DateTimeOffset ExpiresAt);

/// <summary>Roster flags per lease: mute/deafen are self-reported; camera/screen come from LiveKit (webhook/reconcile).</summary>
public sealed record VoiceFlags(bool Muted, bool Deafened, bool Camera, bool Screen);

/// <summary>Post-commit voice roster changes (implemented by the realtime layer). Null state = user left voice.</summary>
public interface IVoiceEventSink
{
    Task VoiceStateChangedAsync(Guid serverId, Guid channelId, Guid userId, VoiceMemberDto? state, CancellationToken ct);
}

/// <summary>Ephemeral self-reported mute/deafen flags per lease. Lost on restart; clients re-report after reconnect.</summary>
public sealed class VoiceStateCache
{
    private static readonly VoiceFlags Empty = new(false, false, false, false);
    private readonly ConcurrentDictionary<Guid, VoiceFlags> states = new();
    public VoiceFlags Get(Guid leaseId) => states.GetValueOrDefault(leaseId, Empty);

    /// <summary>Applies a change; returns true when the flags actually changed.</summary>
    public bool Update(Guid leaseId, Func<VoiceFlags, VoiceFlags> change)
    {
        while (true)
        {
            var exists = states.TryGetValue(leaseId, out var current);
            var before = exists ? current! : Empty;
            var after = change(before);
            if (after == before) return false;
            if (exists ? states.TryUpdate(leaseId, after, current!) : states.TryAdd(leaseId, after)) return true;
        }
    }

    public void Remove(Guid leaseId) => states.TryRemove(leaseId, out _);
}

/// <summary>
/// Media coordination: voice leases (one per user), scoped LiveKit tokens, admission checks, webhook and periodic
/// reconciliation against LiveKit. The lease id is the participant identity, so any token resolves to a DB row.
/// </summary>
public sealed class VoiceService(
    HangarDbContext db,
    PermissionService permissions,
    ILiveKitRooms rooms,
    IVoiceEventSink events,
    VoiceStateCache states,
    ReconcileHealth health,
    AuditService audit,
    IOptions<LiveKitOptions> options,
    TimeProvider clock,
    ILogger<VoiceService> log)
{
    public const string PublisherIdentityPrefix = "sb_";
    private const long AdmissionLockKey = 0x4841_4E47_5643; // "HANGVC"
    private const long PublicationLockKey = 0x4841_4E47_5050; // "HANGPP"
    private LiveKitOptions O => options.Value;

    // ---- client commands ------------------------------------------------------------------------

    public async Task<VoiceJoinResponse> JoinAsync(Guid userId, Guid sessionId, Guid channelId, VoiceJoinRequest req, CancellationToken ct)
    {
        if (req.RequestId == Guid.Empty) throw AppProblem.BadRequest("voice.request_id", "requestId is required.");
        var (channel, mask) = await permissions.RequireChannelAsync(userId, channelId, Permission.JoinVoice, ct);
        if (channel.Type != ChannelType.Voice) throw AppProblem.BadRequest("voice.not_voice_channel", "This is not a voice channel.");
        var now = clock.GetUtcNow();

        // Retry of the same join: hand back the same lease with a fresh token.
        var retry = await db.VoiceLeases.FirstOrDefaultAsync(l => l.UserId == userId && l.RequestId == req.RequestId, ct);
        if (retry is not null)
        {
            if (retry.Status is VoiceLeaseStatus.Revoked or VoiceLeaseStatus.Ended || retry.ChannelId != channelId)
                throw AppProblem.Conflict("voice.request_reused", "This join request has already ended. Join again.");
            return Issue(retry, await SourcesAsync(retry, ct), await DisplayNameAsync(userId, ct), now);
        }

        var room = RoomName(channel);
        try
        {
            await rooms.EnsureRoomAsync(room, O.RoomSlots, ct);
        }
        catch (LiveKitUnavailableException e)
        {
            log.LogWarning(e, "LiveKit unavailable during join");
            throw new AppProblem(503, "voice.unavailable", "Voice is temporarily unavailable. Try again shortly.");
        }

        List<VoiceLease> replaced;
        VoiceLease lease;
        await using (var tx = await db.Database.BeginTransactionAsync(ct))
        {
            // Serialize admissions installation-wide: the human limit and one-lease-per-user are checked atomically.
            await db.Database.ExecuteSqlRawAsync($"SELECT pg_advisory_xact_lock({AdmissionLockKey})", ct);

            replaced = await db.VoiceLeases
                .Where(l => l.UserId == userId && (l.Status == VoiceLeaseStatus.Joining || l.Status == VoiceLeaseStatus.Active))
                .ToListAsync(ct);
            foreach (var old in replaced) End(old, VoiceLeaseStatus.Revoked, "switched", now);
            // Flush before inserting: EF does not order the UPDATE before the INSERT, and ux_voice_leases_one_active would trip.
            if (replaced.Count > 0) await db.SaveChangesAsync(ct);

            var humans = await db.VoiceLeases.CountAsync(l => l.UserId != userId &&
                (l.Status == VoiceLeaseStatus.Joining || l.Status == VoiceLeaseStatus.Active), ct);
            if (humans >= O.MaxHumans)
                throw AppProblem.Conflict("voice.full", $"Voice is full ({O.MaxHumans} people connected). Try again later.");

            lease = new VoiceLease
            {
                Id = Guid.CreateVersion7(),
                UserId = userId,
                SessionId = sessionId,
                ServerId = channel.ServerId,
                ChannelId = channel.Id,
                RoomName = room,
                RoomGeneration = channel.MediaGeneration,
                GrantedPolicyVersion = channel.PolicyVersion,
                Status = VoiceLeaseStatus.Joining,
                RequestId = req.RequestId,
                CanSpeak = mask.HasFlag(Permission.Speak),
                CanCamera = mask.HasFlag(Permission.PublishCamera),
                CanScreen = mask.HasFlag(Permission.ShareScreen),
                ServerMuted = await db.ServerMembers.Where(m => m.ServerId == channel.ServerId && m.UserId == userId)
                    .Select(m => m.VoiceMuted).FirstOrDefaultAsync(ct),
                CreatedAt = now,
                LastConfirmedAt = now,
            };
            db.VoiceLeases.Add(lease);
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
        }

        // Remove the previous participant (other channel or another tab) after commit; failures are reconciled later.
        foreach (var old in replaced) await AfterEndAsync(old, ct);
        return Issue(lease, MicSources(lease), await DisplayNameAsync(userId, ct), now);
    }

    /// <summary>Full reconnect: reauthorizes from current state; a revoked/ended lease never gets a new token.</summary>
    public async Task<VoiceJoinResponse> RefreshTokenAsync(Guid userId, Guid sessionId, Guid leaseId, CancellationToken ct)
    {
        var lease = await OwnLeaseAsync(userId, leaseId, ct);
        if (lease.Status is not (VoiceLeaseStatus.Joining or VoiceLeaseStatus.Active) || lease.SessionId != sessionId)
            throw AppProblem.Conflict("voice.lease_ended", "This voice session has ended. Join again.");
        var (_, mask) = await permissions.RequireChannelAsync(userId, lease.ChannelId, Permission.JoinVoice, ct);
        lease.CanSpeak = mask.HasFlag(Permission.Speak);
        lease.CanCamera = mask.HasFlag(Permission.PublishCamera);
        lease.CanScreen = mask.HasFlag(Permission.ShareScreen);
        await db.SaveChangesAsync(ct);
        return Issue(lease, await SourcesAsync(lease, ct), await DisplayNameAsync(userId, ct), clock.GetUtcNow());
    }

    /// <summary>Client reports it connected; the server verifies with LiveKit instead of trusting the claim.</summary>
    public async Task ConfirmAsync(Guid userId, Guid leaseId, CancellationToken ct)
    {
        var lease = await OwnLeaseAsync(userId, leaseId, ct);
        if (lease.Status is not (VoiceLeaseStatus.Joining or VoiceLeaseStatus.Active)) throw AppProblem.Conflict("voice.lease_ended", "This voice session has ended.");
        IReadOnlyList<LiveKitParticipant>? present;
        try
        {
            present = await rooms.ListParticipantsAsync(lease.RoomName, ct);
        }
        catch (LiveKitUnavailableException)
        {
            return; // The reconciler confirms later.
        }
        if (present?.Any(p => p.Identity == lease.Id.ToString()) == true) await MarkActiveAsync(lease, ct);
    }

    public async Task LeaveAsync(Guid userId, Guid leaseId, CancellationToken ct)
    {
        var lease = await db.VoiceLeases.FirstOrDefaultAsync(l => l.Id == leaseId && l.UserId == userId, ct);
        if (lease is null || lease.Status is VoiceLeaseStatus.Revoked or VoiceLeaseStatus.Ended) return;
        End(lease, VoiceLeaseStatus.Ended, "left", clock.GetUtcNow());
        await db.SaveChangesAsync(ct);
        await AfterEndAsync(lease, ct);
    }

    public async Task UpdateStateAsync(Guid userId, Guid leaseId, VoiceStateUpdate update, CancellationToken ct)
    {
        var lease = await db.VoiceLeases.AsNoTracking().FirstOrDefaultAsync(l => l.Id == leaseId && l.UserId == userId, ct);
        if (lease is null || lease.Status is not (VoiceLeaseStatus.Joining or VoiceLeaseStatus.Active)) return;
        if (states.Update(leaseId, f => f with { Muted = update.Muted, Deafened = update.Deafened }) && Visible(lease))
            await events.VoiceStateChangedAsync(lease.ServerId, lease.ChannelId, userId, ToDto(lease), ct);
    }

    // ---- moderation -------------------------------------------------------------------------------

    /// <summary>
    /// Server mute: sticks to the member (applies to later joins too). While in voice it needs MuteMembers in that
    /// channel; the microphone source is withdrawn and a live mic track is muted at the SFU.
    /// </summary>
    public async Task SetServerMuteAsync(Guid actor, Guid serverId, Guid targetUserId, bool muted, CancellationToken ct)
    {
        var lease = await ActiveLeaseAsync(serverId, targetUserId, ct);
        if (lease is not null) await permissions.RequireChannelAsync(actor, lease.ChannelId, Permission.MuteMembers, ct);
        else await permissions.RequireServerAsync(actor, serverId, Permission.MuteMembers, ct);
        await RequireAboveAsync(actor, serverId, targetUserId, ct);

        var member = await db.ServerMembers.FirstOrDefaultAsync(m => m.ServerId == serverId && m.UserId == targetUserId && m.RemovedAt == null, ct)
                     ?? throw AppProblem.NotFound("member.not_found", "Member not found.");
        member.VoiceMuted = muted;
        if (lease is not null) lease.ServerMuted = muted;
        audit.Record(actor, "member", targetUserId.ToString(), muted ? "voice.server_mute" : "voice.server_unmute");
        await db.SaveChangesAsync(ct);
        if (lease is null) return;

        await SafeUpdateSourcesAsync(lease, ct);
        if (muted)
        {
            try
            {
                var participants = await rooms.ListParticipantsAsync(lease.RoomName, ct) ?? [];
                foreach (var t in participants.Where(p => p.Identity == lease.Id.ToString()).SelectMany(p => p.Tracks).Where(t => t.Source == "MICROPHONE"))
                    await rooms.MuteTrackAsync(lease.RoomName, lease.Id.ToString(), t.Sid, true, ct);
            }
            catch (LiveKitUnavailableException e)
            {
                log.LogWarning(e, "Could not mute the microphone of {Lease}", lease.Id);
            }
        }
        if (Visible(lease)) await events.VoiceStateChangedAsync(lease.ServerId, lease.ChannelId, lease.UserId, ToDto(lease), ct);
    }

    /// <summary>Disconnects a member from voice (needs RemoveFromVoice in their channel). They may rejoin if still allowed.</summary>
    public async Task DisconnectAsync(Guid actor, Guid serverId, Guid targetUserId, CancellationToken ct)
    {
        var lease = await ActiveLeaseAsync(serverId, targetUserId, ct)
                    ?? throw AppProblem.NotFound("voice.not_connected", "This member is not in voice.");
        await permissions.RequireChannelAsync(actor, lease.ChannelId, Permission.RemoveFromVoice, ct);
        await RequireAboveAsync(actor, serverId, targetUserId, ct);
        End(lease, VoiceLeaseStatus.Revoked, "removed", clock.GetUtcNow());
        audit.Record(actor, "member", targetUserId.ToString(), "voice.disconnect", detail: lease.ChannelId.ToString());
        await db.SaveChangesAsync(ct);
        await AfterEndAsync(lease, ct);
    }

    private Task<VoiceLease?> ActiveLeaseAsync(Guid serverId, Guid userId, CancellationToken ct) =>
        db.VoiceLeases.FirstOrDefaultAsync(l => l.ServerId == serverId && l.UserId == userId &&
            (l.Status == VoiceLeaseStatus.Joining || l.Status == VoiceLeaseStatus.Active), ct);

    private async Task RequireAboveAsync(Guid actor, Guid serverId, Guid targetUserId, CancellationToken ct)
    {
        if (actor == targetUserId) return;
        var auth = await permissions.RequireAuthorityAsync(actor, serverId, Permission.None, ct);
        var ownerId = await db.Servers.Where(s => s.Id == serverId).Select(s => s.OwnerUserId).FirstAsync(ct);
        if (!auth.CanManageMember(ownerId == targetUserId, await permissions.TopPositionAsync(targetUserId, serverId, ct), targetUserId))
            throw AppProblem.Forbidden("member.hierarchy", "You can only moderate members below your highest role.");
    }

    // ---- camera / screen publications ------------------------------------------------------------

    /// <summary>
    /// Reserves capacity for a camera or screen publication and grants the matching LiveKit source to this participant only.
    /// The client captures first (inside the click) and publishes only after this succeeds.
    /// </summary>
    public async Task<PublicationDto> ReservePublicationAsync(Guid userId, Guid sessionId, Guid leaseId, PublicationKind kind, PublicationRequest req, CancellationToken ct)
    {
        var lease = await OwnLeaseAsync(userId, leaseId, ct);
        if (lease.Status is not (VoiceLeaseStatus.Joining or VoiceLeaseStatus.Active) || lease.SessionId != sessionId)
            throw AppProblem.Conflict("voice.lease_ended", "This voice session has ended. Join again.");
        var required = kind == PublicationKind.Camera ? Permission.PublishCamera : Permission.ShareScreen;
        await permissions.RequireChannelAsync(userId, lease.ChannelId, Permission.JoinVoice | required, ct);
        var quality = kind == PublicationKind.Camera ? "720p30" : req.Quality switch
        {
            null or "1080p60" => "1080p60",
            "720p30" => "720p30",
            _ => throw AppProblem.BadRequest("media.quality", "Unknown quality preset."),
        };
        var max = kind == PublicationKind.Camera ? O.MaxCameras : O.MaxScreens;
        var now = clock.GetUtcNow();

        MediaPublicationReservation r;
        await using (var tx = await db.Database.BeginTransactionAsync(ct))
        {
            await db.Database.ExecuteSqlRawAsync($"SELECT pg_advisory_xact_lock({PublicationLockKey})", ct);
            r = await db.MediaPublicationReservations.FirstOrDefaultAsync(x => x.VoiceLeaseId == leaseId && x.Kind == kind && x.State == ReservationState.Active, ct)
                ?? new MediaPublicationReservation();
            if (r.Id == Guid.Empty)
            {
                var inUse = await db.MediaPublicationReservations.CountAsync(x => x.Kind == kind && x.State == ReservationState.Active && x.ExpiresAt > now &&
                    db.VoiceLeases.Any(l => l.Id == x.VoiceLeaseId && (l.Status == VoiceLeaseStatus.Joining || l.Status == VoiceLeaseStatus.Active)), ct);
                if (inUse >= max)
                    throw AppProblem.Conflict("media.limit", kind == PublicationKind.Camera
                        ? $"Up to {max} cameras can be on at once. Try again when someone turns theirs off."
                        : $"Up to {max} people can share their screen at once. Try again when a stream ends.");
                r.Id = Guid.CreateVersion7();
                r.VoiceLeaseId = leaseId;
                r.UserId = userId;
                r.ChannelId = lease.ChannelId;
                r.Kind = kind;
                r.State = ReservationState.Active;
                r.CreatedAt = now;
                db.MediaPublicationReservations.Add(r);
            }
            r.Quality = quality;
            r.WithAudio = kind == PublicationKind.Screen && req.WithAudio;
            if (r.ExpiresAt < now + O.PublishWindow) r.ExpiresAt = now + O.PublishWindow;
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
        }
        await SafeUpdateSourcesAsync(lease, ct);
        return ToDto(r);
    }

    public async Task ReleasePublicationAsync(Guid userId, Guid leaseId, PublicationKind kind, CancellationToken ct)
    {
        var lease = await db.VoiceLeases.FirstOrDefaultAsync(l => l.Id == leaseId && l.UserId == userId, ct);
        if (lease is null) return;
        var active = await db.MediaPublicationReservations
            .Where(x => x.VoiceLeaseId == leaseId && x.Kind == kind && x.State == ReservationState.Active).ToListAsync(ct);
        if (active.Count == 0) return;
        foreach (var r in active) r.State = ReservationState.Released;
        await db.SaveChangesAsync(ct);
        if (lease.Status is VoiceLeaseStatus.Joining or VoiceLeaseStatus.Active)
        {
            // Removing the source makes LiveKit unpublish that track: the grant, not the client, is authoritative.
            await SafeUpdateSourcesAsync(lease, ct);
            await SetMediaFlagsAsync(lease, kind == PublicationKind.Camera ? false : null, kind == PublicationKind.Screen ? false : null, ct);
        }
    }

    /// <summary>Roster snapshot of voice channels in a server, limited to channels the caller can see.</summary>
    public async Task<List<VoiceMemberDto>> ListAsync(Guid userId, Guid serverId, CancellationToken ct)
    {
        var visible = await permissions.VisibleChannelsAsync(userId, serverId, ct);
        if (visible.Count == 0) throw AppProblem.NotFound("server.not_found", "Server not found.");
        var ids = visible.Keys.ToList();
        var leases = await db.VoiceLeases.AsNoTracking()
            .Where(l => ids.Contains(l.ChannelId) && (l.Status == VoiceLeaseStatus.Joining || l.Status == VoiceLeaseStatus.Active))
            .ToListAsync(ct);
        return leases.Where(Visible).Select(ToDto).ToList();
    }

    // ---- admission gate (Caddy forward_auth in prod) --------------------------------------------

    /// <summary>
    /// Validates a LiveKit signaling credential against current state. A valid but revoked/out-of-policy token is denied,
    /// closing the self-hosted "removal does not revoke the token" gap.
    /// </summary>
    public async Task<bool> AdmitAsync(string token, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        // Without recent reconciliation, revocations may not be enforced: fail closed for new connections.
        if (!health.Status().Fresh)
        {
            log.LogWarning("Admission refused: voice reconciliation is stale");
            return false;
        }
        var verified = LiveKitTokens.Verify(token, O.ApiKey, O.ApiSecret, now);
        if (verified?.Video is not { } video) return false;
        if (verified.Identity.StartsWith(PublisherIdentityPrefix, StringComparison.Ordinal)) return false; // workers use the internal path
        if (!Guid.TryParse(verified.Identity, out var leaseId)) return false;

        var lease = await db.VoiceLeases.AsNoTracking().FirstOrDefaultAsync(l => l.Id == leaseId, ct);
        if (lease is null || lease.Status is not (VoiceLeaseStatus.Joining or VoiceLeaseStatus.Active)) return false;
        if (video["room"]?.GetValue<string>() != lease.RoomName) return false;

        var sessionOk = await db.UserSessions.AnyAsync(s => s.Id == lease.SessionId && s.UserId == lease.UserId && s.RevokedAt == null
            && s.IdleExpiresAt > now && s.AbsoluteExpiresAt > now, ct);
        var userOk = await db.Users.AnyAsync(u => u.Id == lease.UserId && u.DisabledAt == null, ct);
        if (!sessionOk || !userOk) return false;

        var channel = await db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == lease.ChannelId && c.ArchivedAt == null, ct);
        if (channel is null || RoomName(channel) != lease.RoomName) return false;
        var mask = await permissions.ChannelPermissionsAsync(lease.UserId, channel, ct);
        if (!mask.HasFlag(Permission.JoinVoice)) return false;

        // The presented grant may not exceed what current policy allows.
        var sources = video["canPublishSources"]?.AsArray().Select(n => n?.GetValue<string>()).ToList() ?? [];
        var canPublish = video["canPublish"]?.GetValue<bool>() ?? false;
        if (canPublish && sources.Count == 0) return false; // unrestricted publish is never issued
        if (sources.Contains("microphone") && !mask.HasFlag(Permission.Speak)) return false;
        if (sources.Contains("camera") && !mask.HasFlag(Permission.PublishCamera)) return false;
        if ((sources.Contains("screen_share") || sources.Contains("screen_share_audio")) && !mask.HasFlag(Permission.ShareScreen)) return false;
        if (video["canPublishData"]?.GetValue<bool>() == true || video["roomAdmin"]?.GetValue<bool>() == true || video["roomCreate"]?.GetValue<bool>() == true)
            return false;
        return true;
    }

    // ---- webhooks -------------------------------------------------------------------------------

    /// <summary>Verifies a LiveKit webhook (JWT in Authorization carrying the body's sha256) and applies it.</summary>
    public async Task<bool> HandleWebhookAsync(string? authorization, byte[] body, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(authorization) || body.Length > 64 * 1024) return false;
        var token = authorization.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? authorization[7..] : authorization;
        var verified = LiveKitTokens.Verify(token, O.ApiKey, O.ApiSecret, clock.GetUtcNow());
        if (verified is null || verified.Claims["sha256"]?.GetValue<string>() != LiveKitTokens.Sha256Base64(body)) return false;

        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        var ev = root.TryGetProperty("event", out var e) ? e.GetString() : null;
        var identity = root.TryGetProperty("participant", out var p) && p.TryGetProperty("identity", out var id) ? id.GetString() : null;
        var roomName = root.TryGetProperty("room", out var r) && r.TryGetProperty("name", out var rn) ? rn.GetString() : null;
        if (identity is null || !Guid.TryParse(identity, out var leaseId)) return true; // room events / worker identities: nothing to do yet

        var lease = await db.VoiceLeases.FirstOrDefaultAsync(l => l.Id == leaseId, ct);
        if (lease is null || lease.RoomName != roomName)
        {
            if (ev == "participant_joined" && roomName is not null) await SafeRemoveAsync(roomName, identity, ct);
            return true;
        }
        var source = root.TryGetProperty("track", out var t) && t.TryGetProperty("source", out var s) ? s.GetString() : null;
        switch (ev)
        {
            case "track_published" or "track_unpublished" when source is "CAMERA" or "SCREEN_SHARE":
            {
                var published = ev == "track_published";
                var kind = source == "CAMERA" ? PublicationKind.Camera : PublicationKind.Screen;
                if (published) await RenewReservationAsync(lease.Id, kind, ct);
                else await ReleasePublicationAsync(lease.UserId, lease.Id, kind, ct); // capture ended or user stopped
                await SetMediaFlagsAsync(lease, kind == PublicationKind.Camera ? published : null, kind == PublicationKind.Screen ? published : null, ct);
                break;
            }
            case "participant_joined":
                if (lease.Status is VoiceLeaseStatus.Joining or VoiceLeaseStatus.Active) await MarkActiveAsync(lease, ct);
                else await SafeRemoveAsync(lease.RoomName, identity, ct); // revoked lease reconnected with an old token
                break;
            case "participant_left":
                // Start the reconnect grace; the reconciler ends it if the participant does not return.
                if (lease.Status == VoiceLeaseStatus.Active) await StartGraceAsync(lease, clock.GetUtcNow(), ct);
                break;
        }
        return true;
    }

    // ---- reconciliation -------------------------------------------------------------------------

    /// <summary>
    /// Periodic source of truth: expires unconfirmed leases, revokes leases whose session/policy no longer allows voice,
    /// confirms present participants, and removes LiveKit participants without a live lease.
    /// Returns whether the pass was complete (every room checked); the outcome feeds <see cref="ReconcileHealth"/>.
    /// </summary>
    public async Task<bool> ReconcileAsync(CancellationToken ct)
    {
        var complete = false;
        try
        {
            complete = await ReconcileCoreAsync(ct);
            return complete;
        }
        finally
        {
            health.Record(complete);
        }
    }

    private async Task<bool> ReconcileCoreAsync(CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var live = await db.VoiceLeases
            .Where(l => l.Status == VoiceLeaseStatus.Joining || l.Status == VoiceLeaseStatus.Active)
            .ToListAsync(ct);

        var ended = new List<VoiceLease>();
        foreach (var lease in live)
        {
            var reason = await RevocationReasonAsync(lease, now, ct);
            if (reason is not null)
            {
                End(lease, VoiceLeaseStatus.Revoked, reason, now);
                ended.Add(lease);
            }
        }
        await db.SaveChangesAsync(ct);
        foreach (var l in ended) await AfterEndAsync(l, ct);

        var remaining = live.Except(ended).ToList();
        IReadOnlyList<string> roomNames;
        try
        {
            roomNames = await rooms.ListRoomsAsync(ct);
        }
        catch (LiveKitUnavailableException)
        {
            return false;
        }

        var complete = true;
        foreach (var room in roomNames.Union(remaining.Select(l => l.RoomName)).Distinct())
        {
            IReadOnlyList<LiveKitParticipant>? participants;
            try
            {
                participants = await rooms.ListParticipantsAsync(room, ct);
            }
            catch (LiveKitUnavailableException)
            {
                complete = false;
                continue;
            }
            var byIdentity = (participants ?? []).ToDictionary(p => p.Identity);
            var present = byIdentity.Keys.ToHashSet();
            foreach (var lease in remaining.Where(l => l.RoomName == room))
            {
                if (byIdentity.TryGetValue(lease.Id.ToString(), out var participant))
                {
                    await MarkActiveAsync(lease, ct);
                    await ReconcilePublicationsAsync(lease, participant, now, ct);
                }
                else if (lease.Status == VoiceLeaseStatus.Active)
                {
                    await StartGraceAsync(lease, now, ct);
                }
                else if (now - lease.LastConfirmedAt > O.ReconnectGrace && await TimeoutAsync(lease, now, ct))
                {
                    await AfterEndAsync(lease, ct);
                }
            }
            var allowed = remaining.Where(l => l.RoomName == room).Select(l => l.Id.ToString()).ToHashSet();
            foreach (var identity in present)
                if (!allowed.Contains(identity) && !identity.StartsWith(PublisherIdentityPrefix, StringComparison.Ordinal))
                    await SafeRemoveAsync(room, identity, ct);
        }
        return complete;
    }

    /// <summary>Session revoked (logout, device revoke, password change): its voice leases end immediately.</summary>
    public async Task RevokeForSessionsAsync(Guid userId, IReadOnlyCollection<Guid> sessionIds, string reason, CancellationToken ct)
    {
        var leases = await db.VoiceLeases.Where(l => l.UserId == userId && sessionIds.Contains(l.SessionId) &&
            (l.Status == VoiceLeaseStatus.Joining || l.Status == VoiceLeaseStatus.Active)).ToListAsync(ct);
        var now = clock.GetUtcNow();
        foreach (var l in leases) End(l, VoiceLeaseStatus.Revoked, reason, now);
        await db.SaveChangesAsync(ct);
        foreach (var l in leases) await AfterEndAsync(l, ct);
    }

    // ---- helpers --------------------------------------------------------------------------------

    public static string RoomName(Channel channel) => $"v_{channel.Id:N}_{channel.MediaGeneration}";

    /// <summary>A join grants the microphone only; camera/screen sources exist only while a reservation is active.</summary>
    public static IReadOnlyList<string> MicSources(VoiceLease lease) =>
        lease.CanSpeak && !lease.ServerMuted ? ["microphone"] : [];

    private async Task<IReadOnlyList<string>> SourcesAsync(VoiceLease lease, CancellationToken ct)
    {
        var sources = MicSources(lease).ToList();
        var now = clock.GetUtcNow();
        var reservations = await db.MediaPublicationReservations.AsNoTracking()
            .Where(x => x.VoiceLeaseId == lease.Id && x.State == ReservationState.Active && x.ExpiresAt > now).ToListAsync(ct);
        if (lease.CanCamera && reservations.Any(r => r.Kind == PublicationKind.Camera)) sources.Add("camera");
        if (reservations.FirstOrDefault(r => r.Kind == PublicationKind.Screen) is { } screen && lease.CanScreen)
        {
            sources.Add("screen_share");
            if (screen.WithAudio) sources.Add("screen_share_audio");
        }
        return sources;
    }

    private async Task RenewReservationAsync(Guid leaseId, PublicationKind kind, CancellationToken ct)
    {
        var until = clock.GetUtcNow() + O.PublishWindow + O.ReconcileInterval;
        await db.MediaPublicationReservations
            .Where(x => x.VoiceLeaseId == leaseId && x.Kind == kind && x.State == ReservationState.Active && x.ExpiresAt < until)
            .ExecuteUpdateAsync(u => u.SetProperty(x => x.ExpiresAt, until), ct);
    }

    /// <summary>Renews reservations backed by a live track, releases ones never published in time, refreshes roster flags.</summary>
    private async Task ReconcilePublicationsAsync(VoiceLease lease, LiveKitParticipant participant, DateTimeOffset now, CancellationToken ct)
    {
        var hasCamera = participant.Tracks.Any(t => t.Source == "CAMERA");
        var hasScreen = participant.Tracks.Any(t => t.Source == "SCREEN_SHARE");
        var active = await db.MediaPublicationReservations
            .Where(x => x.VoiceLeaseId == lease.Id && x.State == ReservationState.Active).ToListAsync(ct);
        var changed = false;
        foreach (var r in active)
        {
            var live = r.Kind == PublicationKind.Camera ? hasCamera : hasScreen;
            if (live) r.ExpiresAt = now + O.PublishWindow + O.ReconcileInterval;
            else if (r.ExpiresAt <= now)
            {
                r.State = ReservationState.Released;
                changed = true;
            }
        }
        await db.SaveChangesAsync(ct);
        if (changed) await SafeUpdateSourcesAsync(lease, ct);
        await SetMediaFlagsAsync(lease, hasCamera, hasScreen, ct);
    }

    private async Task SetMediaFlagsAsync(VoiceLease lease, bool? camera, bool? screen, CancellationToken ct)
    {
        if (states.Update(lease.Id, f => f with { Camera = camera ?? f.Camera, Screen = screen ?? f.Screen }) && Visible(lease))
            await events.VoiceStateChangedAsync(lease.ServerId, lease.ChannelId, lease.UserId, ToDto(lease), ct);
    }

    private static PublicationDto ToDto(MediaPublicationReservation r) =>
        new(r.Id, r.Kind == PublicationKind.Camera ? "camera" : "screen", r.Quality, r.WithAudio, r.ExpiresAt);

    private VoiceJoinResponse Issue(VoiceLease lease, IReadOnlyList<string> sources, string displayName, DateTimeOffset now)
    {
        var grant = new VideoGrant
        {
            Room = lease.RoomName,
            RoomJoin = true,
            CanSubscribe = true,
            CanPublish = sources.Count > 0,
            CanPublishSources = sources,
            CanPublishData = false,
            CanUpdateOwnMetadata = false,
        };
        var metadata = JsonSerializer.Serialize(new { userId = lease.UserId });
        var token = LiveKitTokens.Create(O.ApiKey, O.ApiSecret, lease.Id.ToString(), O.JoinTokenLifetime, now, grant, displayName, metadata);
        return new VoiceJoinResponse(lease.Id, lease.ChannelId, O.PublicUrl, token, now.Add(O.JoinTokenLifetime), lease.CanSpeak, lease.CanCamera, lease.CanScreen);
    }

    private async Task<string?> RevocationReasonAsync(VoiceLease lease, DateTimeOffset now, CancellationToken ct)
    {
        var sessionOk = await db.UserSessions.AnyAsync(s => s.Id == lease.SessionId && s.RevokedAt == null && s.IdleExpiresAt > now && s.AbsoluteExpiresAt > now, ct);
        if (!sessionOk) return "session";
        var channel = await db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == lease.ChannelId, ct);
        if (channel is null || channel.ArchivedAt is not null || RoomName(channel) != lease.RoomName) return "channel";
        var mask = await permissions.ChannelPermissionsAsync(lease.UserId, channel, ct);
        if (!mask.HasFlag(Permission.JoinVoice)) return "policy";
        if (lease.CanSpeak && !mask.HasFlag(Permission.Speak))
        {
            // Lost Speak only: downgrade in place rather than kicking.
            lease.CanSpeak = false;
            await SafeUpdateSourcesAsync(lease, ct);
        }
        return null;
    }

    private async Task MarkActiveAsync(VoiceLease lease, CancellationToken ct)
    {
        var wasVisible = Visible(lease);
        var now = clock.GetUtcNow();
        // Conditional write: a concurrent switch/leave may have ended this lease after we loaded it; never resurrect it.
        var updated = await db.VoiceLeases
            .Where(l => l.Id == lease.Id && (l.Status == VoiceLeaseStatus.Joining || l.Status == VoiceLeaseStatus.Active))
            .ExecuteUpdateAsync(u => u.SetProperty(l => l.Status, VoiceLeaseStatus.Active).SetProperty(l => l.LastConfirmedAt, now), ct);
        await db.Entry(lease).ReloadAsync(ct);
        if (updated == 0) return;
        if (!wasVisible) await events.VoiceStateChangedAsync(lease.ServerId, lease.ChannelId, lease.UserId, ToDto(lease), ct);
    }

    // Transitions decided from a snapshot (webhooks, reconciler) are compare-and-set in the database: a concurrent
    // leave/switch may already have ended the lease, and a plain tracked update would resurrect it.

    private async Task StartGraceAsync(VoiceLease lease, DateTimeOffset now, CancellationToken ct)
    {
        await db.VoiceLeases.Where(l => l.Id == lease.Id && l.Status == VoiceLeaseStatus.Active)
            .ExecuteUpdateAsync(u => u.SetProperty(l => l.Status, VoiceLeaseStatus.Joining).SetProperty(l => l.LastConfirmedAt, now), ct);
        await db.Entry(lease).ReloadAsync(ct);
    }

    private async Task<bool> TimeoutAsync(VoiceLease lease, DateTimeOffset now, CancellationToken ct)
    {
        var cutoff = now - O.ReconnectGrace;
        var n = await db.VoiceLeases
            .Where(l => l.Id == lease.Id && l.Status == VoiceLeaseStatus.Joining && l.LastConfirmedAt < cutoff)
            .ExecuteUpdateAsync(u => u.SetProperty(l => l.Status, VoiceLeaseStatus.Ended)
                .SetProperty(l => l.RevokedAt, now).SetProperty(l => l.EndReason, "timeout"), ct);
        await db.Entry(lease).ReloadAsync(ct);
        return n == 1;
    }

    private static void End(VoiceLease lease, VoiceLeaseStatus status, string reason, DateTimeOffset now)
    {
        lease.Status = status;
        lease.RevokedAt = now;
        lease.EndReason = reason;
    }

    private async Task AfterEndAsync(VoiceLease lease, CancellationToken ct)
    {
        states.Remove(lease.Id);
        await db.MediaPublicationReservations
            .Where(x => x.VoiceLeaseId == lease.Id && x.State == ReservationState.Active)
            .ExecuteUpdateAsync(u => u.SetProperty(x => x.State, ReservationState.Released), ct);
        await SafeRemoveAsync(lease.RoomName, lease.Id.ToString(), ct);
        await events.VoiceStateChangedAsync(lease.ServerId, lease.ChannelId, lease.UserId, null, ct);
    }

    private async Task SafeRemoveAsync(string room, string identity, CancellationToken ct)
    {
        try
        {
            await rooms.RemoveParticipantAsync(room, identity, ct);
        }
        catch (LiveKitUnavailableException e)
        {
            log.LogWarning(e, "Could not remove participant {Identity}; the reconciler will retry", identity);
        }
    }

    private async Task SafeUpdateSourcesAsync(VoiceLease lease, CancellationToken ct)
    {
        try
        {
            await rooms.UpdatePublishSourcesAsync(lease.RoomName, lease.Id.ToString(), await SourcesAsync(lease, ct), ct);
        }
        catch (LiveKitUnavailableException e)
        {
            log.LogWarning(e, "Could not update permissions for {Lease}", lease.Id);
        }
    }

    /// <summary>A lease shows in rosters once LiveKit confirmed it, and stays during the reconnect grace.</summary>
    private static bool Visible(VoiceLease l) =>
        l.Status == VoiceLeaseStatus.Active || (l.Status == VoiceLeaseStatus.Joining && l.LastConfirmedAt > l.CreatedAt);

    private VoiceMemberDto ToDto(VoiceLease l)
    {
        var s = states.Get(l.Id);
        return new VoiceMemberDto(l.UserId, l.ChannelId, s.Muted || s.Deafened, s.Deafened, l.ServerMuted, s.Camera, s.Screen, l.CreatedAt);
    }

    private async Task<VoiceLease> OwnLeaseAsync(Guid userId, Guid leaseId, CancellationToken ct) =>
        await db.VoiceLeases.FirstOrDefaultAsync(l => l.Id == leaseId && l.UserId == userId, ct)
        ?? throw AppProblem.NotFound("voice.lease_not_found", "Voice session not found.");

    private async Task<string> DisplayNameAsync(Guid userId, CancellationToken ct) =>
        await db.Users.Where(u => u.Id == userId).Select(u => u.DisplayName).FirstAsync(ct);
}

/// <summary>Ends voice leases when their session is revoked.</summary>
public sealed class VoiceRevocationListener(VoiceService voice) : ISessionRevocationListener
{
    public Task OnSessionsRevokedAsync(Guid userId, IReadOnlyCollection<Guid> sessionIds, string reason, CancellationToken ct) =>
        voice.RevokeForSessionsAsync(userId, sessionIds, reason, ct);
}
