namespace Hangar.Core.Audit;

/// <summary>Redacted security/admin audit record. Never contains JWTs, passwords, uploads or voice content.</summary>
public sealed class AuditEvent
{
    public Guid Id { get; set; }
    public Guid? ActorUserId { get; set; }
    public required string TargetType { get; set; }
    public string? TargetId { get; set; }
    public required string Action { get; set; }
    public DateTimeOffset Time { get; set; }
    public required string Outcome { get; set; }
    public string? RedactedDetail { get; set; }
}
