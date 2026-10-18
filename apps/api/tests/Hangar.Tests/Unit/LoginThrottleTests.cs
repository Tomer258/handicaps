using Hangar.Core.Common;
using Hangar.Core.Identity;

namespace Hangar.Tests.Unit;

public class LoginThrottleTests
{
    private sealed class ManualClock : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = DateTimeOffset.Parse("2026-10-18T12:00:00Z");
        public override DateTimeOffset GetUtcNow() => Now;
    }

    [Fact]
    public void An_account_locks_after_five_failures_but_a_shared_ip_only_after_twenty()
    {
        var clock = new ManualClock();
        var t = new LoginThrottle(clock);
        for (var i = 0; i < 5; i++) t.RecordFailure("alice", "10.0.0.1");
        t.EnsureAllowed("alice", "10.0.0.1"); // five free attempts
        t.RecordFailure("alice", "10.0.0.1");
        Assert.Equal(429, Assert.Throws<AppProblem>(() => t.EnsureAllowed("alice", "10.0.0.9")).Status); // account locked from anywhere

        // Housemates behind the same IP are not locked out by alice's typos...
        for (var i = 0; i < 13; i++) t.RecordFailure("bob" + i, "10.0.0.1");
        t.EnsureAllowed("carol", "10.0.0.1"); // 19 failures from this IP
        t.RecordFailure("carol", "10.0.0.1");
        t.RecordFailure("carol", "10.0.0.1"); // 21
        // ...but a guessing run from one IP still is.
        Assert.Equal(429, Assert.Throws<AppProblem>(() => t.EnsureAllowed("dave", "10.0.0.1")).Status);

        clock.Now += TimeSpan.FromMinutes(16);
        t.EnsureAllowed("dave", "10.0.0.1");
    }
}
