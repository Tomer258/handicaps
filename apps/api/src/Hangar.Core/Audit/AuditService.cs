using Hangar.Core.Persistence;

namespace Hangar.Core.Audit;

public sealed class AuditService(HangarDbContext db, TimeProvider clock)
{
    /// <summary>Adds an audit row to the current unit of work; the caller's SaveChanges commits it.</summary>
    public void Record(Guid? actor, string targetType, string? targetId, string action, string outcome = "ok", string? detail = null)
    {
        db.AuditEvents.Add(new AuditEvent
        {
            Id = Guid.CreateVersion7(),
            ActorUserId = actor,
            TargetType = targetType,
            TargetId = targetId,
            Action = action,
            Outcome = outcome,
            Time = clock.GetUtcNow(),
            RedactedDetail = detail is { Length: > 500 } ? detail[..500] : detail,
        });
    }
}
