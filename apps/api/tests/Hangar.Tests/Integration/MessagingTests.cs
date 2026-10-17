using System.Net;
using System.Net.Http.Json;
using static Hangar.Tests.Integration.Scenario;

namespace Hangar.Tests.Integration;

/// <summary>Phase 2 acceptance: durable idempotent sends, ordering, conflicts, tombstones, deltas, ACLs.</summary>
[Collection("api")]
public class MessagingTests(ApiFactory factory)
{
    [Fact]
    public async Task Retry_with_same_client_id_returns_original_once()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var ch = await NewTextChannelAsync(owner, serverId);
        var key = Guid.NewGuid();
        var first = await SendAsync(owner, ch, "hello", key);
        var second = await SendAsync(owner, ch, "hello", key);
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        Assert.Equal((await Json(first)).GetProperty("id").GetGuid(), (await Json(second)).GetProperty("id").GetGuid());

        var page = await Json(await owner.Http.GetAsync($"/api/v1/channels/{ch}/messages"));
        Assert.Equal(1, page.GetProperty("messages").GetArrayLength());
    }

    [Fact]
    public async Task Retry_with_altered_body_conflicts()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var ch = await NewTextChannelAsync(owner, serverId);
        var key = Guid.NewGuid();
        (await SendAsync(owner, ch, "original", key)).EnsureSuccessStatusCode();
        var altered = await SendAsync(owner, ch, "changed", key);
        Assert.Equal(HttpStatusCode.Conflict, altered.StatusCode);
    }

    [Fact]
    public async Task Concurrent_sends_get_unique_gapless_ordered_sequences()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var ch = await NewTextChannelAsync(owner, serverId);
        var results = await Task.WhenAll(Enumerable.Range(0, 20).Select(i => SendAsync(owner, ch, $"msg {i}")));
        Assert.All(results, r => Assert.Equal(HttpStatusCode.Created, r.StatusCode));

        var page = await Json(await owner.Http.GetAsync($"/api/v1/channels/{ch}/messages?limit=100"));
        var seqs = page.GetProperty("messages").EnumerateArray().Select(m => long.Parse(m.GetProperty("messageSequence").GetString()!)).ToList();
        Assert.Equal(Enumerable.Range(1, 20).Select(i => (long)i), seqs);

        var events = await Json(await owner.Http.GetAsync($"/api/v1/channels/{ch}/events?after=0"));
        var eseq = events.GetProperty("events").EnumerateArray().Select(e => long.Parse(e.GetProperty("eventSequence").GetString()!)).ToList();
        Assert.Equal(Enumerable.Range(1, 20).Select(i => (long)i), eseq);
    }

    [Fact]
    public async Task Edit_with_stale_version_conflicts_and_delete_leaves_tombstone()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var ch = await NewTextChannelAsync(owner, serverId);
        var msg = await Json(await SendAsync(owner, ch, "v1"));
        var id = msg.GetProperty("id").GetGuid();

        var ok = await owner.Http.PatchAsJsonAsync($"/api/v1/messages/{id}", new { expectedVersion = 1, body = "v2" });
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        var stale = await owner.Http.PatchAsJsonAsync($"/api/v1/messages/{id}", new { expectedVersion = 1, body = "v3" });
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);

        // Reply, then delete the parent: the reply keeps resolving to a tombstone, not to unrelated data.
        var reply = await Json(await SendAsync(owner, ch, "reply", replyTo: id));
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Http.DeleteAsync($"/api/v1/messages/{id}")).StatusCode);
        var page = await Json(await owner.Http.GetAsync($"/api/v1/channels/{ch}/messages"));
        var msgs = page.GetProperty("messages").EnumerateArray().ToList();
        var tomb = msgs.First(m => m.GetProperty("id").GetGuid() == id);
        Assert.True(tomb.GetProperty("deleted").GetBoolean());
        Assert.Equal("", tomb.GetProperty("body").GetString());
        var replyRow = msgs.First(m => m.GetProperty("id").GetGuid() == reply.GetProperty("id").GetGuid());
        Assert.True(replyRow.GetProperty("replyTo").GetProperty("deleted").GetBoolean());

        var events = await Json(await owner.Http.GetAsync($"/api/v1/channels/{ch}/events?after=0"));
        var types = events.GetProperty("events").EnumerateArray().Select(e => e.GetProperty("type").GetString()).ToList();
        Assert.Equal(["message.created", "message.updated", "message.created", "message.deleted"], types);
    }

    [Fact]
    public async Task Reactions_are_idempotent_and_recorded_as_events()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var ch = await NewTextChannelAsync(owner, serverId);
        var id = (await Json(await SendAsync(owner, ch, "react to me"))).GetProperty("id").GetGuid();
        var emoji = Uri.EscapeDataString("😂");
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Http.PutAsync($"/api/v1/messages/{id}/reactions/{emoji}", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Http.PutAsync($"/api/v1/messages/{id}/reactions/{emoji}", null)).StatusCode);
        var page = await Json(await owner.Http.GetAsync($"/api/v1/channels/{ch}/messages"));
        var reactions = page.GetProperty("messages")[0].GetProperty("reactions");
        Assert.Equal(1, reactions[0].GetProperty("count").GetInt32());
        var events = await Json(await owner.Http.GetAsync($"/api/v1/channels/{ch}/events?after=1"));
        Assert.Single(events.GetProperty("events").EnumerateArray());
    }

    [Fact]
    public async Task Denied_channel_is_absent_from_history_events_and_sends()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var secret = await NewTextChannelAsync(owner, serverId, "secret" + Random.Shared.Next(100, 999));
        var detail = await Json(await owner.Http.GetAsync($"/api/v1/servers/{serverId}"));
        var defaultRole = detail.GetProperty("roles").EnumerateArray().First(r => r.GetProperty("isDefault").GetBoolean()).GetProperty("id").GetGuid();
        (await owner.Http.PutAsJsonAsync($"/api/v1/channels/{secret}/overrides", new { roleId = defaultRole, allow = 0, deny = 1 })).EnsureSuccessStatusCode();
        (await SendAsync(owner, secret, "owners only")).EnsureSuccessStatusCode();

        var (member, _) = await MemberAsync(factory, owner, serverId);
        Assert.Equal(HttpStatusCode.NotFound, (await member.Http.GetAsync($"/api/v1/channels/{secret}/messages")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await member.Http.GetAsync($"/api/v1/channels/{secret}/events?after=0")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await SendAsync(member, secret, "let me in")).StatusCode);
        var mine = await Json(await member.Http.GetAsync($"/api/v1/servers/{serverId}"));
        Assert.DoesNotContain(mine.GetProperty("channels").EnumerateArray(), c => c.GetProperty("id").GetGuid() == secret);
        var unread = await Json(await member.Http.GetAsync($"/api/v1/servers/{serverId}/unread"));
        Assert.DoesNotContain(unread.EnumerateArray(), c => c.GetProperty("channelId").GetGuid() == secret);
    }

    [Fact]
    public async Task Mentions_create_unread_counts_and_read_position_is_monotonic()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var ch = await NewTextChannelAsync(owner, serverId);
        var (member, memberId) = await MemberAsync(factory, owner, serverId);

        (await SendAsync(owner, ch, $"hey <@{memberId}> come play")).EnsureSuccessStatusCode();
        (await SendAsync(owner, ch, "second")).EnsureSuccessStatusCode();
        var unread = await Json(await member.Http.GetAsync($"/api/v1/servers/{serverId}/unread"));
        var row = unread.EnumerateArray().First(c => c.GetProperty("channelId").GetGuid() == ch);
        Assert.Equal(2, row.GetProperty("unread").GetInt32());
        Assert.Equal(1, row.GetProperty("mentions").GetInt32());

        (await member.Http.PutAsJsonAsync($"/api/v1/channels/{ch}/read-position", new { messageSequence = "2" })).EnsureSuccessStatusCode();
        (await member.Http.PutAsJsonAsync($"/api/v1/channels/{ch}/read-position", new { messageSequence = "1" })).EnsureSuccessStatusCode();
        unread = await Json(await member.Http.GetAsync($"/api/v1/servers/{serverId}/unread"));
        row = unread.EnumerateArray().First(c => c.GetProperty("channelId").GetGuid() == ch);
        Assert.Equal(0, row.GetProperty("unread").GetInt32());
        Assert.Equal(0, row.GetProperty("mentions").GetInt32());
        Assert.Equal("2", row.GetProperty("lastReadMessageSequence").GetString());
    }

    [Fact]
    public async Task History_paginates_with_keyset_cursor()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var ch = await NewTextChannelAsync(owner, serverId);
        for (var i = 0; i < 7; i++) (await SendAsync(owner, ch, $"m{i}")).EnsureSuccessStatusCode();
        var p1 = await Json(await owner.Http.GetAsync($"/api/v1/channels/{ch}/messages?limit=5"));
        Assert.True(p1.GetProperty("hasMore").GetBoolean());
        var oldest = p1.GetProperty("messages")[0].GetProperty("messageSequence").GetString();
        Assert.Equal("3", oldest);
        var p2 = await Json(await owner.Http.GetAsync($"/api/v1/channels/{ch}/messages?limit=5&before={oldest}"));
        Assert.False(p2.GetProperty("hasMore").GetBoolean());
        Assert.Equal(2, p2.GetProperty("messages").GetArrayLength());
    }
}
