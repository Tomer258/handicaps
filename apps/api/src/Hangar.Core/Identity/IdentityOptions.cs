namespace Hangar.Core.Identity;

public sealed class HangarIdentityOptions
{
    public TimeSpan PersistentIdle { get; set; } = TimeSpan.FromDays(7);
    public TimeSpan PersistentAbsolute { get; set; } = TimeSpan.FromDays(30);
    public TimeSpan BrowserSessionIdle { get; set; } = TimeSpan.FromHours(12);
    public TimeSpan BrowserSessionAbsolute { get; set; } = TimeSpan.FromDays(1);
    public TimeSpan DefaultInviteLifetime { get; set; } = TimeSpan.FromHours(48);
    public TimeSpan MaxInviteLifetime { get; set; } = TimeSpan.FromDays(14);
    public int MaxInviteUses { get; set; } = 15;
    public int MinPasswordLength { get; set; } = 10;
}
