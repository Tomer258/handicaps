using Hangar.Core.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Hangar.Core.Audit;

/// <summary>Bounded scheduled cleanup per docs/architecture/data-model-and-contracts.md §7.</summary>
public sealed class RetentionService(HangarDbContext db, TimeProvider clock)
{
    public async Task<int> RunAsync(CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var total = 0;
        // Channel event payloads: seven days (only dispatched rows; undispatched rows alert instead of vanishing).
        total += await db.ChannelEvents.Where(e => e.CommittedAt < now.AddDays(-7) && e.DispatchedAt != null).ExecuteDeleteAsync(ct);
        // Expired/revoked sessions and invitations: keep audit, drop secrets/records.
        total += await db.UserSessions.Where(s => s.AbsoluteExpiresAt < now.AddDays(-1) || (s.RevokedAt != null && s.RevokedAt < now.AddDays(-7))).ExecuteDeleteAsync(ct);
        total += await db.Invitations.Where(i => i.ExpiresAt < now.AddDays(-7) || (i.RevokedAt != null && i.RevokedAt < now.AddDays(-7))).ExecuteDeleteAsync(ct);
        // Read notifications older than 30 days.
        total += await db.Notifications.Where(n => n.ReadAt != null && n.ReadAt < now.AddDays(-30)).ExecuteDeleteAsync(ct);
        // Terminal playback commands: 24 hours.
        total += await db.SoundPlaybackCommands.Where(c => c.AcceptedAt < now.AddHours(-24) &&
            c.State != Soundboard.PlaybackState.Accepted && c.State != Soundboard.PlaybackState.Starting && c.State != Soundboard.PlaybackState.Playing)
            .ExecuteDeleteAsync(ct);
        // Security/admin audit: 90 days.
        total += await db.AuditEvents.Where(a => a.Time < now.AddDays(-90)).ExecuteDeleteAsync(ct);
        return total;
    }
}
