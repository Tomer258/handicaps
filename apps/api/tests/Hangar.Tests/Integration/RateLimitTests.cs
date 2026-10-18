using System.Net;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using static Hangar.Tests.Integration.Scenario;

namespace Hangar.Tests.Integration;

/// <summary>A host with tiny abuse limits (its own database).</summary>
public sealed class RateLimitedFactory : ApiFactory
{
    protected override void Configure(IWebHostBuilder builder)
    {
        builder.UseSetting("Hangar:RateLimits:Enabled", "true");
        builder.UseSetting("Hangar:RateLimits:Messages:Burst", "3");
        builder.UseSetting("Hangar:RateLimits:Messages:PerMinute", "1");
        builder.UseSetting("Hangar:RateLimits:Writes:Burst", "20");
        builder.UseSetting("Hangar:RateLimits:Writes:PerMinute", "1");
        builder.UseSetting("Hangar:RateLimits:Hub:Burst", "3");
        builder.UseSetting("Hangar:RateLimits:Hub:PerMinute", "1");
    }
}

/// <summary>Phase 7 abuse checks: per-user REST buckets with 429 + Retry-After, and per-connection hub budgets.</summary>
public class RateLimitTests(RateLimitedFactory factory) : IClassFixture<RateLimitedFactory>
{
    [Fact]
    public async Task Message_flood_gets_429_per_user_while_reads_and_other_users_continue()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var (member, _) = await MemberAsync(factory, owner, serverId);
        var ch = await NewTextChannelAsync(owner, serverId);

        for (var i = 0; i < 3; i++) Assert.Equal(HttpStatusCode.Created, (await SendAsync(owner, ch, $"m{i}")).StatusCode);
        var limited = await SendAsync(owner, ch, "one too many");
        Assert.Equal((HttpStatusCode)429, limited.StatusCode);
        Assert.Equal("rate_limited", (await Json(limited)).GetProperty("code").GetString());
        Assert.True(limited.Headers.RetryAfter?.Delta >= TimeSpan.FromSeconds(1));

        Assert.Equal(HttpStatusCode.OK, (await owner.Http.GetAsync($"/api/v1/channels/{ch}/messages")).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await SendAsync(member, ch, "still fine")).StatusCode);
    }

    [Fact]
    public async Task Hub_invocations_beyond_the_budget_fail_without_dropping_the_connection()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var ch = await NewTextChannelAsync(owner, serverId);
        var cookie = owner.Handler.Cookies.GetCookieHeader(new Uri("http://localhost"));
        await using var hub = new HubConnectionBuilder()
            .WithUrl("http://localhost/hubs/realtime", o =>
            {
                o.Transports = HttpTransportType.LongPolling;
                o.HttpMessageHandlerFactory = _ => factory.Server.CreateHandler();
                o.Headers["Cookie"] = cookie;
            })
            .Build();
        await hub.StartAsync();

        for (var i = 0; i < 3; i++) await hub.InvokeAsync("Typing", ch);
        var ex = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync("Typing", ch));
        Assert.Contains("rate_limited", ex.Message);
        Assert.Equal(HubConnectionState.Connected, hub.State);
    }
}
