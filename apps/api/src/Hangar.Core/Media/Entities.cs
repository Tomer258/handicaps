namespace Hangar.Core.Media;

public enum VoiceLeaseStatus
{
    Joining = 0,
    Active = 1,
    Revoked = 2,
    Ended = 3,
}

/// <summary>
/// One user's authorization to be in one voice room. At most one Joining/Active lease per user.
/// The lease id is the LiveKit participant identity, so admission can resolve a JWT back to this row.
/// </summary>
public sealed class VoiceLease
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid SessionId { get; set; }
    public Guid ServerId { get; set; }
    public Guid ChannelId { get; set; }
    public required string RoomName { get; set; }
    public long RoomGeneration { get; set; }
    public long GrantedPolicyVersion { get; set; }
    public VoiceLeaseStatus Status { get; set; }
    /// <summary>Client idempotency key for join retries.</summary>
    public Guid RequestId { get; set; }
    public bool CanSpeak { get; set; }
    public bool CanCamera { get; set; }
    public bool CanScreen { get; set; }
    /// <summary>Server-side mute applied by a moderator.</summary>
    public bool ServerMuted { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset LastConfirmedAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
    public string? EndReason { get; set; }
}

public enum PublicationKind
{
    Camera = 0,
    Screen = 1,
}

public enum ReservationState
{
    Active = 0,
    Released = 1,
}

/// <summary>Serializes the installation-wide camera/screen publisher limits.</summary>
public sealed class MediaPublicationReservation
{
    public Guid Id { get; set; }
    public Guid VoiceLeaseId { get; set; }
    public Guid UserId { get; set; }
    public Guid ChannelId { get; set; }
    public PublicationKind Kind { get; set; }
    public ReservationState State { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset ExpiresAt { get; set; }
    public string? Quality { get; set; }
    public bool WithAudio { get; set; }
}
