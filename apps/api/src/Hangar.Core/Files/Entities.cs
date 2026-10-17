namespace Hangar.Core.Files;

public enum FilePurpose
{
    Attachment = 0,
    Avatar = 1,
    SoundSource = 2,
    SoundReady = 3,
}

public enum FileState
{
    Pending = 0,
    Ready = 1,
    Rejected = 2,
    Deleted = 3,
}

public sealed class FileAsset
{
    public Guid Id { get; set; }
    public Guid ServerId { get; set; }
    public Guid OwnerUserId { get; set; }
    public FilePurpose Purpose { get; set; }
    /// <summary>Random internal storage key; never derived from the client filename.</summary>
    public required string StorageKey { get; set; }
    public required string Mime { get; set; }
    /// <summary>Client-supplied name, sanitized; used only for Content-Disposition.</summary>
    public required string OriginalName { get; set; }
    public long SizeBytes { get; set; }
    public string? Sha256 { get; set; }
    public int? Width { get; set; }
    public int? Height { get; set; }
    public FileState State { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }
}
