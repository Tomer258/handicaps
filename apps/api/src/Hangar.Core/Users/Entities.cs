namespace Hangar.Core.Users;

public enum PreferredStatus
{
    Online = 0,
    Idle = 1,
    DoNotDisturb = 2,
    Invisible = 3,
}

public sealed class UserSettings
{
    public Guid UserId { get; set; }
    public PreferredStatus PreferredStatus { get; set; }
    /// <summary>Bounded JSON (jsonb): notification preferences only — never credentials.</summary>
    public string NotificationPreferences { get; set; } = "{}";
    /// <summary>Bounded JSON (jsonb): volumes, devices, ducking, per-user gains.</summary>
    public string AudioPreferences { get; set; } = "{}";
    /// <summary>Bounded JSON (jsonb): theme, accent, density, reduced motion.</summary>
    public string AppearancePreferences { get; set; } = "{}";
    public long Version { get; set; } = 1;
}
