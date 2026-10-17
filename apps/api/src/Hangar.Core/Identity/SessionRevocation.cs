namespace Hangar.Core.Identity;

/// <summary>
/// Implemented by modules that hold live state per session (SignalR connections, voice leases).
/// Called after the revocation is committed; listeners must be idempotent.
/// </summary>
public interface ISessionRevocationListener
{
    Task OnSessionsRevokedAsync(Guid userId, IReadOnlyCollection<Guid> sessionIds, string reason, CancellationToken ct);
}

public sealed class SessionRevocationNotifier(IEnumerable<ISessionRevocationListener> listeners)
{
    public async Task NotifyAsync(Guid userId, IReadOnlyCollection<Guid> sessionIds, string reason, CancellationToken ct)
    {
        if (sessionIds.Count == 0) return;
        foreach (var l in listeners)
            await l.OnSessionsRevokedAsync(userId, sessionIds, reason, ct);
    }
}
