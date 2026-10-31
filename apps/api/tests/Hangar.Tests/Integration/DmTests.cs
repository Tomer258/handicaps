using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using static Hangar.Tests.Integration.Scenario;

namespace Hangar.Tests.Integration;

/// <summary>Direct and group messages: participants only (not even the owner), one conversation per pair, groups.</summary>
[Collection("api")]
public class DmTests(ApiFactory factory)
{
    private static Task<HttpResponseMessage> OpenAsync(TestClient c, Guid serverId, params Guid[] userIds) =>
        c.Http.PostAsJsonAsync($"/api/v1/servers/{serverId}/dms", new { userIds });

    private static IEnumerable<JsonElement> Channels(JsonElement detail) => detail.GetProperty("channels").EnumerateArray();

    [Fact]
    public async Task A_direct_message_is_private_to_the_two_people_and_unique_per_pair()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var (a, aId) = await MemberAsync(factory, owner, serverId, "a");
        var (b, bId) = await MemberAsync(factory, owner, serverId, "b");

        var dm = await Json(await OpenAsync(a, serverId, bId));
        Assert.Equal("direct", dm.GetProperty("type").GetString());
        var id = dm.GetProperty("id").GetGuid();
        Assert.Equal(new[] { aId, bId }.Order(), dm.GetProperty("participants").EnumerateArray().Select(x => x.GetGuid()).Order());
        // Opening again, from either side, finds the same conversation.
        Assert.Equal(id, (await Json(await OpenAsync(a, serverId, bId))).GetProperty("id").GetGuid());
        Assert.Equal(id, (await Json(await OpenAsync(b, serverId, aId))).GetProperty("id").GetGuid());

        (await SendAsync(a, id, "psst, ranked at 9?")).EnsureSuccessStatusCode();
        var history = await Json(await b.Http.GetAsync($"/api/v1/channels/{id}/messages?limit=5"));
        Assert.Equal("psst, ranked at 9?", history.GetProperty("messages")[0].GetProperty("body").GetString());

        // The owner (all permissions) cannot read, send or even see it.
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Http.GetAsync($"/api/v1/channels/{id}/messages?limit=5")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await SendAsync(owner, id, "hi")).StatusCode);
        Assert.DoesNotContain(Channels(await Json(await owner.Http.GetAsync($"/api/v1/servers/{serverId}"))), c => c.GetProperty("id").GetGuid() == id);
        var search = await Json(await owner.Http.GetAsync($"/api/v1/servers/{serverId}/messages/search?q=ranked%20at%209"));
        Assert.DoesNotContain(search.GetProperty("messages").EnumerateArray(), m => m.GetProperty("channelId").GetGuid() == id);

        // B sees it in the server detail with the participants, and it counts like a mention until read.
        Assert.Contains(Channels(await Json(await b.Http.GetAsync($"/api/v1/servers/{serverId}"))),
            c => c.GetProperty("id").GetGuid() == id && c.GetProperty("participants").GetArrayLength() == 2);
        var unread = (await Json(await b.Http.GetAsync($"/api/v1/servers/{serverId}/unread"))).EnumerateArray().First(r => r.GetProperty("channelId").GetGuid() == id);
        Assert.Equal(1, unread.GetProperty("unread").GetInt32());
        Assert.Equal(1, unread.GetProperty("mentions").GetInt32());

        // Not a group: nobody can be added; you cannot DM yourself or strangers.
        Assert.Equal(HttpStatusCode.BadRequest, (await a.Http.PostAsJsonAsync($"/api/v1/channels/{id}/members", new { userIds = new[] { bId } })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await OpenAsync(a, serverId, aId)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await OpenAsync(a, serverId, Guid.NewGuid())).StatusCode);
    }

    [Fact]
    public async Task Groups_add_rename_and_leave()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var (a, _) = await MemberAsync(factory, owner, serverId, "a");
        var (b, bId) = await MemberAsync(factory, owner, serverId, "b");
        var (c, cId) = await MemberAsync(factory, owner, serverId, "c");
        var (d, dId) = await MemberAsync(factory, owner, serverId, "d");

        var group = await Json(await OpenAsync(a, serverId, bId, cId));
        Assert.Equal("group", group.GetProperty("type").GetString());
        var id = group.GetProperty("id").GetGuid();
        Assert.Equal(3, group.GetProperty("participants").GetArrayLength());
        // A second group with the same people is a new conversation (like Discord).
        Assert.NotEqual(id, (await Json(await OpenAsync(a, serverId, bId, cId))).GetProperty("id").GetGuid());

        var renamed = await Json(await b.Http.PatchAsJsonAsync($"/api/v1/channels/{id}/group", new { name = "Squad" }));
        Assert.Equal("Squad", renamed.GetProperty("name").GetString());

        Assert.Equal(HttpStatusCode.NotFound, (await d.Http.GetAsync($"/api/v1/channels/{id}/messages?limit=5")).StatusCode);
        var added = await Json(await c.Http.PostAsJsonAsync($"/api/v1/channels/{id}/members", new { userIds = new[] { dId } }));
        Assert.Equal(4, added.GetProperty("participants").GetArrayLength());
        Assert.Equal(HttpStatusCode.OK, (await d.Http.GetAsync($"/api/v1/channels/{id}/messages?limit=5")).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await c.Http.DeleteAsync($"/api/v1/channels/{id}/members/me")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await SendAsync(c, id, "still here?")).StatusCode);
        (await SendAsync(d, id, "hi all")).EnsureSuccessStatusCode();

        var tooMany = Enumerable.Range(0, 10).Select(_ => Guid.NewGuid()).ToArray();
        Assert.Equal(HttpStatusCode.BadRequest, (await OpenAsync(a, serverId, tooMany)).StatusCode);
    }
}
