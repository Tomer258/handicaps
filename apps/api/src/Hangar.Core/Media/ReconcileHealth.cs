using Microsoft.Extensions.Options;

namespace Hangar.Core.Media;

/// <summary>
/// Outcome of voice reconciliation (the revocation path that does not depend on webhooks). Admission refuses new
/// joins once it is stale, and the host-local watchdog (workers/auth-watchdog) closes public signaling when it has
/// been unhealthy for 60 s, so authorization drift is bounded even while existing media keeps flowing.
/// </summary>
public sealed class ReconcileHealth(TimeProvider clock, IOptions<LiveKitOptions> options)
{
    private readonly Lock _gate = new();
    private readonly DateTimeOffset _started = clock.GetUtcNow();
    private DateTimeOffset? _lastSuccess;
    private DateTimeOffset? _lastAttempt;
    private bool _lastOk = true;

    /// <summary>Three missed passes: long enough to ride out one slow LiveKit or database call.</summary>
    public TimeSpan StaleAfter => options.Value.ReconcileInterval * 3;

    public void Record(bool complete)
    {
        var now = clock.GetUtcNow();
        lock (_gate)
        {
            _lastAttempt = now;
            _lastOk = complete;
            if (complete) _lastSuccess = now;
        }
    }

    public ReconcileStatus Status()
    {
        var now = clock.GetUtcNow();
        lock (_gate)
        {
            // A fresh process gets one stale window to complete its first pass.
            var fresh = now - (_lastSuccess ?? _started) <= StaleAfter;
            return new ReconcileStatus(fresh && _lastOk, fresh, _lastSuccess, _lastAttempt);
        }
    }
}

/// <param name="Healthy">The last pass completed and the last success is recent.</param>
/// <param name="Fresh">A pass completed within <see cref="ReconcileHealth.StaleAfter"/> (admission requires this).</param>
public sealed record ReconcileStatus(bool Healthy, bool Fresh, DateTimeOffset? LastSuccessAt, DateTimeOffset? LastAttemptAt);
