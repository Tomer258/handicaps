using Hangar.Core.Media;
using Microsoft.Extensions.Options;

namespace Hangar.Tests.Unit;

public class ReconcileHealthTests
{
    private sealed class ManualClock : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = new(2026, 10, 18, 12, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private static (ReconcileHealth Health, ManualClock Clock) Create()
    {
        var clock = new ManualClock();
        var health = new ReconcileHealth(clock, Options.Create(new LiveKitOptions { ReconcileInterval = TimeSpan.FromSeconds(15) }));
        return (health, clock);
    }

    [Fact]
    public void New_process_gets_one_stale_window_for_its_first_pass()
    {
        var (health, clock) = Create();
        Assert.True(health.Status().Healthy);
        clock.Now += TimeSpan.FromSeconds(46);
        var s = health.Status();
        Assert.False(s.Fresh);
        Assert.False(s.Healthy);
        Assert.Null(s.LastSuccessAt);
    }

    [Fact]
    public void Incomplete_pass_is_unhealthy_but_admission_stays_open_until_stale()
    {
        var (health, clock) = Create();
        health.Record(true);
        clock.Now += TimeSpan.FromSeconds(15);
        health.Record(false);
        var s = health.Status();
        Assert.False(s.Healthy);
        Assert.True(s.Fresh);

        clock.Now += TimeSpan.FromSeconds(31); // 46 s since the last complete pass
        Assert.False(health.Status().Fresh);

        health.Record(true);
        s = health.Status();
        Assert.True(s.Healthy);
        Assert.True(s.Fresh);
        Assert.Equal(clock.Now, s.LastSuccessAt);
    }
}
