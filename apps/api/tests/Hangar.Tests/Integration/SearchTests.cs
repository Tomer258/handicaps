using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using static Hangar.Tests.Integration.Scenario;

namespace Hangar.Tests.Integration;

/// <summary>Server message search: visibility-scoped, literal (wildcard-safe), script-agnostic, tombstones excluded.</summary>
[Collection("api")]
public class SearchTests(ApiFactory factory)
{
    private static async Task<List<string>> SearchAsync(TestClient c, Guid serverId, string query)
    {
        var r = await c.Http.GetAsync($"/api/v1/servers/{serverId}/messages/search?{query}");
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        return (await Json(r)).GetProperty("messages").EnumerateArray().Select(m => m.GetProperty("body").GetString()!).ToList();
    }

    private static async Task<Guid> SentIdAsync(TestClient c, Guid channelId, string body)
    {
        var r = await SendAsync(c, channelId, body);
        Assert.Equal(HttpStatusCode.Created, r.StatusCode);
        return (await Json(r)).GetProperty("id").GetGuid();
    }

    [Fact]
    public async Task Finds_only_visible_live_messages_with_literal_matching()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var (member, memberId) = await MemberAsync(factory, owner, serverId);
        var open = await NewTextChannelAsync(owner, serverId);
        var hidden = await NewTextChannelAsync(owner, serverId);
        (await owner.Http.PutAsJsonAsync($"/api/v1/channels/{hidden}/overrides", new { memberUserId = memberId, allow = 0, deny = 1 })).EnsureSuccessStatusCode();

        var tag = "zq" + Guid.NewGuid().ToString("N")[..8];
        await SentIdAsync(owner, open, $"{tag} game night at 9");
        await SentIdAsync(owner, open, $"{tag} 100% sure_thing");
        await SentIdAsync(member, open, $"{tag} שלום עולם");
        await SentIdAsync(owner, hidden, $"{tag} secret plans");
        var gone = await SentIdAsync(owner, open, $"{tag} deleted later");
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Http.DeleteAsync($"/api/v1/messages/{gone}")).StatusCode);

        Assert.Equal(4, (await SearchAsync(owner, serverId, $"q={tag}")).Count);
        var forMember = await SearchAsync(member, serverId, $"q={tag}");
        Assert.Equal(3, forMember.Count);
        Assert.DoesNotContain(forMember, b => b.Contains("secret"));
        Assert.Empty(await SearchAsync(member, serverId, $"q={tag}&channel={hidden}"));

        // Newest first; LIKE wildcards are literal; case-insensitive; any script.
        Assert.Equal($"{tag} שלום עולם", forMember[0]);
        Assert.Equal([$"{tag} 100% sure_thing"], await SearchAsync(member, serverId, $"q={Uri.EscapeDataString(tag + " 100%")}"));
        Assert.Single(await SearchAsync(member, serverId, $"q={Uri.EscapeDataString("_thing")}"));
        Assert.Single(await SearchAsync(member, serverId, $"q={Uri.EscapeDataString(tag + " GAME")}"));
        Assert.Single(await SearchAsync(member, serverId, $"q={Uri.EscapeDataString("עולם")}&from={memberId}"));

        // Author filter alone, and paging with the opaque cursor.
        var page = await Json(await member.Http.GetAsync($"/api/v1/servers/{serverId}/messages/search?q={tag}&limit=2"));
        Assert.Equal(2, page.GetProperty("messages").GetArrayLength());
        var next = page.GetProperty("next").GetString();
        var rest = await SearchAsync(member, serverId, $"q={tag}&limit=2&before={next}");
        Assert.Single(rest);
        Assert.Equal(JsonValueKind.Null, (await Json(await member.Http.GetAsync(
            $"/api/v1/servers/{serverId}/messages/search?q={tag}&limit=2&before={next}"))).GetProperty("next").ValueKind);
    }

    [Fact]
    public async Task Rejects_empty_queries_and_outsiders()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.Http.GetAsync($"/api/v1/servers/{serverId}/messages/search?q=%20")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.Http.GetAsync($"/api/v1/servers/{serverId}/messages/search?q={new string('x', 101)}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Http.GetAsync($"/api/v1/servers/{Guid.NewGuid()}/messages/search?q=hi")).StatusCode);
    }
}
