using System.Text.Json;
using Hangar.Core.Common;
using Hangar.Core.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Hangar.Core.Users;

public sealed record ProfileDto(Guid Id, string Login, string DisplayName, int AvatarHue, Guid? AvatarAssetId, DateTimeOffset CreatedAt);

public sealed record SettingsDto(string PreferredStatus, JsonElement Notifications, JsonElement Audio, JsonElement Appearance, string Version);

public sealed record SettingsPatch(string? PreferredStatus, JsonElement? Notifications, JsonElement? Audio, JsonElement? Appearance, string ExpectedVersion);

public sealed class UserService(HangarDbContext db, IProfileChangeSink profileSink)
{
    private const int MaxPreferenceBytes = 16 * 1024;

    public async Task<ProfileDto> GetProfileAsync(Guid userId, CancellationToken ct) =>
        await db.Users.AsNoTracking().Where(u => u.Id == userId)
            .Select(u => new ProfileDto(u.Id, u.Login, u.DisplayName, u.AvatarHue, u.AvatarAssetId, u.CreatedAt))
            .FirstOrDefaultAsync(ct) ?? throw AppProblem.NotFound();

    public async Task<ProfileDto> UpdateProfileAsync(Guid userId, string? displayName, int? avatarHue, CancellationToken ct)
    {
        var user = await db.Users.FirstAsync(u => u.Id == userId, ct);
        if (displayName is not null) user.DisplayName = Guard.Text(displayName, "displayName", 1, 32);
        if (avatarHue is not null) user.AvatarHue = Math.Clamp(avatarHue.Value, 0, 359);
        await db.SaveChangesAsync(ct);
        await profileSink.ProfileChangedAsync(userId, ct);
        return await GetProfileAsync(userId, ct);
    }

    public async Task<SettingsDto> GetSettingsAsync(Guid userId, CancellationToken ct)
    {
        var s = await db.UserSettings.AsNoTracking().FirstOrDefaultAsync(x => x.UserId == userId, ct);
        if (s is null)
        {
            s = new UserSettings { UserId = userId };
            db.UserSettings.Add(s);
            await db.SaveChangesAsync(ct);
        }
        return ToDto(s);
    }

    public async Task<SettingsDto> PatchSettingsAsync(Guid userId, SettingsPatch patch, CancellationToken ct)
    {
        var s = await db.UserSettings.FirstOrDefaultAsync(x => x.UserId == userId, ct) ?? throw AppProblem.NotFound();
        if (Guard.Cursor(patch.ExpectedVersion, "expectedVersion") != s.Version)
            throw AppProblem.PreconditionFailed("settings.version", "Settings changed elsewhere. Reload and retry.");

        if (patch.PreferredStatus is not null)
            s.PreferredStatus = Enum.TryParse<PreferredStatus>(patch.PreferredStatus, true, out var st)
                ? st : throw AppProblem.BadRequest("validation.preferredStatus", "Unknown status.");
        if (patch.Notifications is { } n) s.NotificationPreferences = Bounded(n, "notifications");
        if (patch.Audio is { } a) s.AudioPreferences = Bounded(a, "audio");
        if (patch.Appearance is { } ap) s.AppearancePreferences = Bounded(ap, "appearance");
        s.Version++;
        await db.SaveChangesAsync(ct);
        if (patch.PreferredStatus is not null) await profileSink.ProfileChangedAsync(userId, ct);
        return ToDto(s);
    }

    private static string Bounded(JsonElement e, string field)
    {
        if (e.ValueKind != JsonValueKind.Object)
            throw AppProblem.BadRequest($"validation.{field}", $"{field} must be a JSON object.");
        var raw = e.GetRawText();
        if (raw.Length > MaxPreferenceBytes)
            throw AppProblem.TooLarge($"validation.{field}", $"{field} is too large.");
        return raw;
    }

    private static SettingsDto ToDto(UserSettings s) => new(
        s.PreferredStatus.ToString(),
        JsonDocument.Parse(s.NotificationPreferences).RootElement.Clone(),
        JsonDocument.Parse(s.AudioPreferences).RootElement.Clone(),
        JsonDocument.Parse(s.AppearancePreferences).RootElement.Clone(),
        s.Version.ToString());
}

public interface IProfileChangeSink
{
    Task ProfileChangedAsync(Guid userId, CancellationToken ct);
}
