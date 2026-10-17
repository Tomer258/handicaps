using System.Collections.Concurrent;
using System.Text.Json;
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

/// <summary>Post-commit voice roster changes (implemented by the realtime layer). Null state = user left voice.</summary>
public interface IVoiceEventSink
{
    Task VoiceStateChangedAsync(Guid serverId, Guid channelId, Guid userId, VoiceMemberDto? state, CancellationToken ct);
}

/// <summary>Ephemeral self-reported mute/deafen flags per lease. Lost on restart; clients re-report after reconnect.</summary>
public sealed class VoiceStateCache
{
    private readonly ConcurrentDictionary<Guid, VoiceStateUpdate> states = new();
    public VoiceStateUpdate Get(Guid leaseId) => states.GetValueOrDefault(leaseId, new VoiceStateUpdate(false, false));
    public void Set(Guid leaseId, VoiceStateUpdate s) => states[leaseId] = s;
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
    IOptions<LiveKitOptions> options,
    TimeProvider clock,
    ILogger<VoiceService> log)
{
    public const string PublisherIdentityPrefix = "sb_";
    private const long AdmissionLockKey = 0x4841_4E47_5643; // "HANGVC"
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
            return Issue(retry, await DisplayNameAsync(userId, ct), now);
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
                CreatedAt = now,
                LastConfirmedAt = now,
            };
            db.VoiceLeases.Add(lease);
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
        }

        // Remove the previous participant (other channel or another tab) after commit; failures are reconciled later.
        foreach (var old in replaced) await AfterEndAsync(old, ct);
        return Issue(lease, await DisplayNameAsync(userId, ct), now);
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
        return Issue(lease, await DisplayNameAsync(userId, ct), clock.GetUtcNow());
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
        var before = states.Get(leaseId);
        if (before == update) return;
        states.Set(leaseId, update);
        if (Visible(lease)) await events.VoiceStateChangedAsync(lease.ServerId, lease.ChannelId, userId, ToDto(lease), ct);
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
        switch (ev)
        {
            case "participant_joined":
                if (lease.Status is VoiceLeaseStatus.Joining or VoiceLeaseStatus.Active) await MarkActiveAsync(lease, ct);
                else await SafeRemoveAsync(lease.RoomName, identity, ct); // revoked lease reconnected with an old token
                break;
            case "participant_left":
                if (lease.Status == VoiceLeaseStatus.Active)
                {
                    // Start the reconnect grace; the reconciler ends it if the participant does not return.
                    lease.Status = VoiceLeaseStatus.Joining;
                    lease.LastConfirmedAt = clock.GetUtcNow();
                    await db.SaveChangesAsync(ct);
                }
                break;
        }
        return true;
    }

    // ---- reconciliation -------------------------------------------------------------------------

    /// <summary>
    /// Periodic source of truth: expires unconfirmed leases, revokes leases whose session/policy no longer allows voice,
    /// confirms present participants, and removes LiveKit participants without a live lease.
    /// </summary>
    public async Task ReconcileAsync(CancellationToken ct)
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
            return;
        }

        foreach (var room in roomNames.Union(remaining.Select(l => l.RoomName)).Distinct())
        {
            IReadOnlyList<LiveKitParticipant>? participants;
            try
            {
                participants = await rooms.ListParticipantsAsync(room, ct);
            }
            catch (LiveKitUnavailableException)
            {
                continue;
            }
            var present = (participants ?? []).Select(p => p.Identity).ToHashSet();
            foreach (var lease in remaining.Where(l => l.RoomName == room))
            {
                if (present.Contains(lease.Id.ToString()))
                {
                    await MarkActiveAsync(lease, ct);
                }
                else if (lease.Status == VoiceLeaseStatus.Active)
                {
                    lease.Status = VoiceLeaseStatus.Joining;
                    lease.LastConfirmedAt = now;
                    await db.SaveChangesAsync(ct);
                }
                else if (now - lease.LastConfirmedAt > O.ReconnectGrace)
                {
                    End(lease, VoiceLeaseStatus.Ended, "timeout", now);
                    await db.SaveChangesAsync(ct);
                    await AfterEndAsync(lease, ct);
                }
            }
            var allowed = remaining.Where(l => l.RoomName == room).Select(l => l.Id.ToString()).ToHashSet();
            foreach (var identity in present)
                if (!allowed.Contains(identity) && !identity.StartsWith(PublisherIdentityPrefix, StringComparison.Ordinal))
                    await SafeRemoveAsync(room, identity, ct);
        }
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

    public static IReadOnlyList<string> PublishSources(VoiceLease lease) =>
        // Camera/screen are added per publication reservation (S5); a join grants the microphone only.
        lease.CanSpeak && !lease.ServerMuted ? ["microphone"] : [];

    private VoiceJoinResponse Issue(VoiceLease lease, string displayName, DateTimeOffset now)
    {
        var sources = PublishSources(lease);
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
        lease.Status = VoiceLeaseStatus.Active;
        lease.LastConfirmedAt = clock.GetUtcNow();
        await db.SaveChangesAsync(ct);
        if (!wasVisible) await events.VoiceStateChangedAsync(lease.ServerId, lease.ChannelId, lease.UserId, ToDto(lease), ct);
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
            await rooms.UpdatePublishSourcesAsync(lease.RoomName, lease.Id.ToString(), PublishSources(lease), ct);
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
        return new VoiceMemberDto(l.UserId, l.ChannelId, s.Muted || s.Deafened, s.Deafened, l.ServerMuted, false, false, l.CreatedAt);
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
