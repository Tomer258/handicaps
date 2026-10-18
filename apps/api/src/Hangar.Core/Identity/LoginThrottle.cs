using System.Collections.Concurrent;
using Hangar.Core.Common;

namespace Hangar.Core.Identity;

/// <summary>
/// In-process failed-login throttle keyed by both account and IP (single API replica by design).
/// Increasing delay after repeated failures; temporary lockout. The fixed-window rate limiter in the host is an extra layer.
/// </summary>
public sealed class LoginThrottle(TimeProvider clock)
{
    private sealed class Entry
    {
        public int Failures;
        public DateTimeOffset LockedUntil;
        public DateTimeOffset LastFailure;
    }

    private readonly ConcurrentDictionary<string, Entry> _entries = new();
    private const int FreeAttemptsPerAccount = 5;
    // An IP may be a household or a dorm behind one NAT: looser, so friends' typos don't lock each other out.
    private const int FreeAttemptsPerIp = 20;
    private static readonly TimeSpan MaxLock = TimeSpan.FromMinutes(15);
    private static readonly TimeSpan Forget = TimeSpan.FromHours(1);

    public void EnsureAllowed(string login, string ip)
    {
        var now = clock.GetUtcNow();
        foreach (var key in Keys(login, ip))
        {
            if (_entries.TryGetValue(key, out var e) && e.LockedUntil > now)
                throw AppProblem.TooMany("auth.throttled", "Too many attempts. Try again later.", e.LockedUntil - now);
        }
    }

    public void RecordFailure(string login, string ip)
    {
        var now = clock.GetUtcNow();
        foreach (var key in Keys(login, ip))
        {
            var e = _entries.GetOrAdd(key, _ => new Entry());
            lock (e)
            {
                if (now - e.LastFailure > Forget) e.Failures = 0;
                e.Failures++;
                e.LastFailure = now;
                var free = key.StartsWith("i:", StringComparison.Ordinal) ? FreeAttemptsPerIp : FreeAttemptsPerAccount;
                if (e.Failures > free)
                {
                    var seconds = Math.Min(Math.Pow(2, e.Failures - free), MaxLock.TotalSeconds);
                    e.LockedUntil = now + TimeSpan.FromSeconds(seconds);
                }
            }
        }
    }

    public void RecordSuccess(string login, string ip) => _entries.TryRemove("l:" + login, out _);

    private static IEnumerable<string> Keys(string login, string ip) => ["l:" + login, "i:" + ip];
}
