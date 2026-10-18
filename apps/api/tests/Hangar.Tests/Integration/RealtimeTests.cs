using System.Collections.Concurrent;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;
using static Hangar.Tests.Integration.Scenario;

namespace Hangar.Tests.Integration;

/// <summary>SignalR integration with real server + DB: authorized subscription, delivery filtering, revocation.</summary>
[Collection("api")]
public class RealtimeTests(ApiFactory factory)
{
    private HubConnection Hub(TestClient client)
    {
        var cookie = client.Handler.Cookies.GetCookieHeader(new Uri("http://localhost"));
        return new HubConnectionBuilder()
            .WithUrl("http://localhost/hubs/realtime", o =>
            {
                o.Transports = HttpTransportType.LongPolling;
                o.HttpMessageHandlerFactory = _ => factory.Server.CreateHandler();
                o.Headers["Cookie"] = cookie;
            })
            .Build();
    }

    private sealed record Ack(Guid ChannelId, string Cursor, string PolicyVersion);

    [Fact]
    public async Task Subscriber_receives_committed_events_in_order()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var ch = await NewTextChannelAsync(owner, serverId);
        var (member, _) = await MemberAsync(factory, owner, serverId);

        await using var hub = Hub(member);
        var received = new ConcurrentQueue<JsonElement>();
        hub.On<JsonElement>("channelEvent", e => received.Enqueue(e));
        await hub.StartAsync();
        var acks = await hub.InvokeAsync<List<Ack>>("SubscribeChannels", new List<Guid> { ch });
        Assert.Single(acks);
        Assert.Equal("0", acks[0].Cursor);

        for (var i = 0; i < 3; i++) (await SendAsync(owner, ch, $"live {i}")).EnsureSuccessStatusCode();
        await WaitUntil(() => received.Count >= 3);
        var seqs = received.Select(e => e.GetProperty("eventSequence").GetString()).ToList();
        Assert.Equal(["1", "2", "3"], seqs);
        Assert.All(received, e => Assert.Equal("message.created", e.GetProperty("type").GetString()));
    }

    [Fact]
    public async Task Denied_channel_is_not_subscribed_and_events_are_not_delivered()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var ch = await NewTextChannelAsync(owner, serverId);
        var (member, memberId) = await MemberAsync(factory, owner, serverId);

        await using var hub = Hub(member);
        var received = new ConcurrentQueue<JsonElement>();
        hub.On<JsonElement>("channelEvent", e => received.Enqueue(e));
        await hub.StartAsync();
        Assert.Single(await hub.InvokeAsync<List<Ack>>("SubscribeChannels", new List<Guid> { ch }));

        // Revoke access while subscribed: the stale subscription must not leak new events.
        (await owner.Http.PutAsJsonAsync($"/api/v1/channels/{ch}/overrides", new { memberUserId = memberId, allow = 0, deny = 1 })).EnsureSuccessStatusCode();
        (await SendAsync(owner, ch, "after revoke")).EnsureSuccessStatusCode();
        await Task.Delay(1500);
        Assert.Empty(received);
        Assert.Empty(await hub.InvokeAsync<List<Ack>>("SubscribeChannels", new List<Guid> { ch }));
    }

    [Fact]
    public async Task Going_offline_records_when_the_member_was_last_here()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var (member, memberId) = await MemberAsync(factory, owner, serverId);
        JsonElement Row(JsonElement list) => list.EnumerateArray().First(m => m.GetProperty("userId").GetGuid() == memberId);

        var before = Row(await Json(await owner.Http.GetAsync($"/api/v1/servers/{serverId}/members")));
        Assert.Equal(JsonValueKind.Null, before.GetProperty("lastOnlineAt").ValueKind);

        var hub = Hub(member);
        await hub.StartAsync();
        var start = DateTimeOffset.UtcNow.AddSeconds(-1);
        await hub.DisposeAsync();
        JsonElement after = default;
        await WaitUntil(() =>
        {
            after = Row(Json(owner.Http.GetAsync($"/api/v1/servers/{serverId}/members").Result).Result);
            return after.GetProperty("lastOnlineAt").ValueKind != JsonValueKind.Null;
        });
        Assert.True(after.GetProperty("lastOnlineAt").GetDateTimeOffset() >= start);
    }

    [Fact]
    public async Task Revoked_session_hub_cannot_invoke_and_is_closed()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var (member, _) = await MemberAsync(factory, owner, serverId);
        await using var hub = Hub(member);
        var closed = new TaskCompletionSource();
        var revoked = new TaskCompletionSource();
        hub.Closed += _ => { closed.TrySetResult(); return Task.CompletedTask; };
        hub.On<JsonElement>("sessionRevoked", _ => revoked.TrySetResult());
        await hub.StartAsync();

        var sessions = await Json(await member.Http.GetAsync("/api/v1/auth/sessions"));
        var sid = sessions[0].GetProperty("id").GetString();
        (await member.Http.DeleteAsync($"/api/v1/auth/sessions/{sid}")).EnsureSuccessStatusCode();

        await Task.WhenAny(closed.Task, Task.Delay(10_000));
        Assert.True(closed.Task.IsCompleted, "hub connection should be aborted server-side");
    }

    private static async Task WaitUntil(Func<bool> condition, int timeoutMs = 10_000)
    {
        var start = Environment.TickCount64;
        while (!condition())
        {
            if (Environment.TickCount64 - start > timeoutMs) throw new TimeoutException();
            await Task.Delay(50);
        }
    }
}
