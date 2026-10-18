using Hangar.Core.Common;
using Hangar.Core.Permissions;
using Hangar.Core.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Hangar.Core.Audit;

public sealed record AuditEntryDto(
    Guid Id, DateTimeOffset Time, Guid? ActorUserId, string? ActorName, string Action, string TargetType, string? TargetId,
    string? TargetName, string Outcome, string? Detail);

public sealed record AuditPageDto(IReadOnlyList<AuditEntryDto> Entries, DateTimeOffset? Before);

/// <summary>
/// The server's moderation/admin log (ViewAudit). One installation = one server, so every admin event belongs to it.
/// Personal session events (login, logout, device revoke, password change) are never listed here.
/// </summary>
public sealed class AuditLogService(HangarDbContext db, PermissionService permissions)
{
    private static readonly string[] AdminTargets = ["channel", "invitation", "member", "role", "server"];

    public async Task<AuditPageDto> ListAsync(Guid actor, Guid serverId, DateTimeOffset? before, int? limit, CancellationToken ct)
    {
        await permissions.RequireServerAsync(actor, serverId, Permission.ViewAudit, ct);
        var take = Math.Clamp(limit ?? 50, 1, 100);
        var q = db.AuditEvents.AsNoTracking().Where(a => AdminTargets.Contains(a.TargetType) || a.Action == "auth.register");
        if (before is not null) q = q.Where(a => a.Time < before);
        var rows = await q.OrderByDescending(a => a.Time).ThenByDescending(a => a.Id).Take(take).ToListAsync(ct);

        var userIds = rows.Select(r => r.ActorUserId).OfType<Guid>()
            .Concat(rows.Where(r => r.TargetType is "member" or "user").Select(r => Guid.TryParse(r.TargetId, out var g) ? g : Guid.Empty))
            .Where(g => g != Guid.Empty).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var roleIds = rows.Where(r => r.TargetType == "role").Select(r => Guid.TryParse(r.TargetId, out var g) ? g : Guid.Empty).ToList();
        var roles = await db.Roles.AsNoTracking().Where(r => roleIds.Contains(r.Id)).ToDictionaryAsync(r => r.Id, r => r.Name, ct);
        // Deleted roles: their delete event kept the name.
        var gone = roleIds.Where(id => !roles.ContainsKey(id)).Select(id => id.ToString()).ToList();
        if (gone.Count > 0)
            foreach (var d in await db.AuditEvents.AsNoTracking().Where(a => a.Action == "role.delete" && gone.Contains(a.TargetId!))
                         .Select(a => new { a.TargetId, a.RedactedDetail }).ToListAsync(ct))
                if (d.RedactedDetail is not null) roles[Guid.Parse(d.TargetId!)] = d.RedactedDetail;
        var channelIds = rows.Where(r => r.TargetType == "channel").Select(r => Guid.TryParse(r.TargetId, out var g) ? g : Guid.Empty).ToList();
        var channels = await db.Channels.AsNoTracking().Where(c => channelIds.Contains(c.Id)).ToDictionaryAsync(c => c.Id, c => c.Name, ct);

        string? TargetName(AuditEvent e)
        {
            if (!Guid.TryParse(e.TargetId, out var id)) return null;
            return e.TargetType switch
            {
                "member" or "user" => names.GetValueOrDefault(id),
                "role" => roles.GetValueOrDefault(id),
                "channel" => channels.GetValueOrDefault(id),
                _ => null,
            };
        }

        var entries = rows.Select(e => new AuditEntryDto(e.Id, e.Time, e.ActorUserId,
            e.ActorUserId is { } a ? names.GetValueOrDefault(a) : null, e.Action, e.TargetType, e.TargetId, TargetName(e), e.Outcome,
            e.Action.StartsWith("auth.", StringComparison.Ordinal) ? null : e.RedactedDetail)).ToList();
        return new AuditPageDto(entries, rows.Count == take ? rows[^1].Time : null);
    }
}
