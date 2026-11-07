using System.Net;
using System.Net.Http.Json;
using static Hangar.Tests.Integration.Scenario;

namespace Hangar.Tests.Integration;

/// <summary>Several hangars on one install: only the install owner creates them; people see only hangars they joined.</summary>
[Collection("api")]
public class MultiHangarTests(ApiFactory factory)
{
    private static async Task<List<Guid>> ServersOf(TestClient c) =>
        [.. (await Json(await c.Http.GetAsync("/api/v1/auth/me"))).GetProperty("servers").EnumerateArray().Select(s => s.GetProperty("id").GetGuid())];

    [Fact]
    public async Task Only_the_install_owner_creates_hangars_and_people_see_only_theirs()
    {
        var (owner, mainId) = await OwnerAsync(factory);
        var (member, _) = await MemberAsync(factory, owner, mainId);

        Assert.True((await Json(await owner.Http.GetAsync("/api/v1/auth/me"))).GetProperty("canCreateServers").GetBoolean());
        Assert.False((await Json(await member.Http.GetAsync("/api/v1/auth/me"))).GetProperty("canCreateServers").GetBoolean());
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Http.PostAsJsonAsync("/api/v1/servers", new { name = "Mine" })).StatusCode);

        var created = await Json(await owner.Http.PostAsJsonAsync("/api/v1/servers", new { name = "Second Hangar" }));
        var second = created.GetProperty("id").GetGuid();
        Assert.True(created.GetProperty("isOwner").GetBoolean());
        Assert.Contains(second, await ServersOf(owner));
        var detail = await Json(await owner.Http.GetAsync($"/api/v1/servers/{second}"));
        Assert.Equal(["general", "clips", "Lounge", "AFK"], detail.GetProperty("channels").EnumerateArray().Select(c => c.GetProperty("name").GetString()));
        Assert.Equal(3, detail.GetProperty("roles").GetArrayLength());

        // Not invited: not listed and not readable.
        Assert.DoesNotContain(second, await ServersOf(member));
        Assert.False((await member.Http.GetAsync($"/api/v1/servers/{second}")).IsSuccessStatusCode);
        Assert.False((await member.Http.GetAsync($"/api/v1/servers/{second}/members")).IsSuccessStatusCode);

    }

    [Fact]
    public async Task An_existing_account_joins_with_an_invite_link_and_can_leave()
    {
        var (owner, mainId) = await OwnerAsync(factory);
        var (member, memberId) = await MemberAsync(factory, owner, mainId);
        var second = (await Json(await owner.Http.PostAsJsonAsync("/api/v1/servers", new { name = "Join Test" }))).GetProperty("id").GetGuid();
        var secret = await InviteAsync(owner, second, maxUses: 2);

        var preview = await Json(await member.Http.PostAsJsonAsync("/api/v1/auth/invitations/preview", new { secret }));
        Assert.Equal(second, preview.GetProperty("serverId").GetGuid());

        var joined = await Json(await member.Http.PostAsJsonAsync("/api/v1/auth/invitations/accept", new { secret }));
        Assert.Equal(second, joined.GetProperty("serverId").GetGuid());
        Assert.Contains(second, await ServersOf(member));
        Assert.Contains(mainId, await ServersOf(member));
        // Already in: no second use of the link.
        await member.Http.PostAsJsonAsync("/api/v1/auth/invitations/accept", new { secret });
        var invites = await Json(await owner.Http.GetAsync($"/api/v1/servers/{second}/invitations"));
        Assert.Equal(1, invites.EnumerateArray().Single().GetProperty("usedCount").GetInt32());

        // DMs are per hangar: the same two people get a separate conversation here.
        var dmMain = await Json(await owner.Http.PostAsJsonAsync($"/api/v1/servers/{mainId}/dms", new { userIds = new[] { memberId } }));
        var dmSecond = await Json(await owner.Http.PostAsJsonAsync($"/api/v1/servers/{second}/dms", new { userIds = new[] { memberId } }));
        Assert.NotEqual(dmMain.GetProperty("id").GetGuid(), dmSecond.GetProperty("id").GetGuid());
        Assert.Equal(second, dmSecond.GetProperty("serverId").GetGuid());
        var ownerId = (await Json(await owner.Http.GetAsync("/api/v1/auth/me"))).GetProperty("user").GetProperty("id").GetGuid();
        var again = await Json(await member.Http.PostAsJsonAsync($"/api/v1/servers/{second}/dms", new { userIds = new[] { ownerId } }));
        Assert.Equal(dmSecond.GetProperty("id").GetGuid(), again.GetProperty("id").GetGuid());

        // Leaving: gone from the list; the owner can't leave their own hangar.
        Assert.Equal(HttpStatusCode.NoContent, (await member.Http.DeleteAsync($"/api/v1/servers/{second}/members/me")).StatusCode);
        Assert.DoesNotContain(second, await ServersOf(member));
        Assert.False((await member.Http.GetAsync($"/api/v1/servers/{second}")).IsSuccessStatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await owner.Http.DeleteAsync($"/api/v1/servers/{second}/members/me")).StatusCode);

        // Rejoining with the link works (second use).
        Assert.True((await member.Http.PostAsJsonAsync("/api/v1/auth/invitations/accept", new { secret })).IsSuccessStatusCode);
        Assert.Contains(second, await ServersOf(member));
    }
}
