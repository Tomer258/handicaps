namespace Hangar.Core.Identity;

public sealed class User
{
    public Guid Id { get; set; }
    public required string Login { get; set; }
    public required string NormalizedLogin { get; set; }
    public string PasswordHash { get; set; } = string.Empty;
    public required string DisplayName { get; set; }
    public Guid? AvatarAssetId { get; set; }
    /// <summary>Hue seed for the generated avatar color when no avatar image exists.</summary>
    public int AvatarHue { get; set; }
    public DateTimeOffset? DisabledAt { get; set; }
    /// <summary>Incremented on password reset/disable; sessions carrying an older value are rejected.</summary>
    public int SecurityVersion { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class UserSession
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset LastSeenAt { get; set; }
    public DateTimeOffset IdleExpiresAt { get; set; }
    public DateTimeOffset AbsoluteExpiresAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
    public int SecurityVersion { get; set; }
    public bool Persistent { get; set; }
    public string? DeviceLabel { get; set; }
}

public enum InvitationPurpose
{
    Member = 0,
    /// <summary>Generated once at first startup; redeeming it makes the account the server owner.</summary>
    OwnerBootstrap = 1,
}

public sealed class Invitation
{
    public Guid Id { get; set; }
    public Guid ServerId { get; set; }
    public required string TokenHash { get; set; }
    public InvitationPurpose Purpose { get; set; }
    public Guid? CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset ExpiresAt { get; set; }
    public int MaxUses { get; set; } = 1;
    public int UsedCount { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
    public string? Note { get; set; }
}
