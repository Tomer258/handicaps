namespace Hangar.Core.Soundboard;

public enum SoundState
{
    Pending = 0,
    Ready = 1,
    Rejected = 2,
    Deleted = 3,
}

public sealed class SoundboardSound
{
    public Guid Id { get; set; }
    public Guid ServerId { get; set; }
    public Guid OwnerUserId { get; set; }
    public required string Name { get; set; }
    public string? Emoji { get; set; }
    public int DurationMs { get; set; }
    public Guid? ActiveVersionId { get; set; }
    public SoundState State { get; set; }
    public string? RejectReason { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }
    public uint Version { get; set; }
}

/// <summary>Immutable normalized output (48 kHz stereo s16 WAV). Replacing bytes creates a new version.</summary>
public sealed class SoundAssetVersion
{
    public Guid Id { get; set; }
    public Guid SoundId { get; set; }
    public Guid FileAssetId { get; set; }
    public int VersionNumber { get; set; }
    public required string Sha256 { get; set; }
    public int SampleRate { get; set; }
    public int Channels { get; set; }
    public double? Loudness { get; set; }
    public double? TruePeak { get; set; }
    public int DurationMs { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class SoundboardFavorite
{
    public Guid UserId { get; set; }
    public Guid SoundId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public enum PlaybackState
{
    Accepted = 0,
    Starting = 1,
    Playing = 2,
    Completed = 3,
    Rejected = 4,
    Stopped = 5,
    Expired = 6,
    Failed = 7,
}

public sealed class SoundPlaybackCommand
{
    public Guid Id { get; set; }
    public Guid RequestId { get; set; }
    public Guid ServerId { get; set; }
    public Guid ChannelId { get; set; }
    public required string RoomName { get; set; }
    public long RoomGeneration { get; set; }
    public Guid VoiceLeaseId { get; set; }
    public Guid ActorUserId { get; set; }
    public Guid SoundId { get; set; }
    public Guid SoundVersionId { get; set; }
    public long WorkerEpoch { get; set; }
    public PlaybackState State { get; set; }
    public int DurationMs { get; set; }
    public DateTimeOffset AcceptedAt { get; set; }
    public DateTimeOffset StartDeadline { get; set; }
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? EndedAt { get; set; }
    public Guid? StoppedBy { get; set; }
    public string? FailureCode { get; set; }

    public static bool IsActive(PlaybackState s) => s is PlaybackState.Accepted or PlaybackState.Starting or PlaybackState.Playing;
}

public enum ValidationJobState
{
    Queued = 0,
    Processing = 1,
    Succeeded = 2,
    Failed = 3,
}

public sealed class AssetValidationJob
{
    public Guid Id { get; set; }
    public Guid AssetId { get; set; }
    public Guid SoundId { get; set; }
    public required string JobType { get; set; }
    public ValidationJobState State { get; set; }
    public int Attempt { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? LeaseExpiresAt { get; set; }
    public string? ResultHash { get; set; }
    public string? ErrorCode { get; set; }
    public double? TrimStartSeconds { get; set; }
    public double? TrimEndSeconds { get; set; }
}
