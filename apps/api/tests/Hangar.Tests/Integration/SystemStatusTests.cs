using System.Net;
using System.Text.Json;
using Hangar.Api.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static Hangar.Tests.Integration.Scenario;

namespace Hangar.Tests.Integration;

/// <summary>System page: administrators only; reports this process, the database and (when fresh) the ops monitor's services.</summary>
[Collection("api")]
public class SystemStatusTests(ApiFactory factory)
{
    [Fact]
    public async Task Administrators_see_resource_usage()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var (member, _) = await MemberAsync(factory, owner, serverId);
        var url = $"/api/v1/servers/{serverId}/system";

        Assert.Equal(HttpStatusCode.Forbidden, (await member.Http.GetAsync(url)).StatusCode);

        var sampler = factory.Services.GetRequiredService<ResourceSampler>();
        sampler.Sample();
        sampler.Sample();
        var s = await Json(await owner.Http.GetAsync(url));
        Assert.Contains(s.GetProperty("projectScope").GetString(), new[] { "api", "services" });
        Assert.True(s.GetProperty("api").GetProperty("memoryMb").GetDouble() > 10);
        Assert.True(s.GetProperty("host").GetProperty("cores").GetInt32() >= 1);
        Assert.True(s.GetProperty("database").GetProperty("sizeMb").GetDouble() > 0);
        Assert.Contains(s.GetProperty("database").GetProperty("largest").EnumerateArray(), t => t.GetProperty("name").GetString() == "messages");
        Assert.True(s.GetProperty("history").GetArrayLength() >= 1);
        Assert.True(s.GetProperty("live").GetProperty("connections").GetInt32() >= 0);
    }

    [Fact]
    public void Parses_proc_stat_and_meminfo()
    {
        var a = HostStats.ParseProcStat("cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 2 3")!.Value;
        var b = HostStats.ParseProcStat("cpu  250 0 250 900 0 0 0 0 0 0\n")!.Value;
        Assert.Equal(75.0, 100.0 * (b.Busy - a.Busy) / (b.Total - a.Total));
        var m = HostStats.ParseMeminfo("MemTotal: 2048000 kB\nMemFree: 100 kB\nMemAvailable: 512000 kB\n")!.Value;
        Assert.Equal(2000, m.TotalMb);
        Assert.Equal(500, m.AvailableMb);
    }

    [Fact]
    public void Parses_docker_stats_sizes()
    {
        Assert.Equal(53.73, ResourceSampler.ParseSize("53.73MiB")!.Value, 2);
        Assert.Equal(15544.32, ResourceSampler.ParseSize("15.18GiB")!.Value, 2);
        Assert.Equal(2.36, ResourceSampler.ParsePercent("2.36%"));
        Assert.Null(ResourceSampler.ParseSize("12 apples"));
    }
}
