using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using static Hangar.Tests.Integration.Scenario;

namespace Hangar.Tests.Integration;

/// <summary>Server settings: name, icon, where join messages go. Administrator only.</summary>
[Collection("api")]
public class ServerSettingsTests(ApiFactory factory)
{
    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4];

    [Fact]
    public async Task Only_administrators_change_the_server_and_join_messages_follow_the_settings()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var (member, _) = await MemberAsync(factory, owner, serverId);
        var before = await Json(await owner.Http.GetAsync($"/api/v1/servers/{serverId}"));
        var name = before.GetProperty("name").GetString()!;
        Assert.True(before.GetProperty("joinMessages").GetBoolean());

        Assert.Equal(HttpStatusCode.Forbidden, (await member.Http.PatchAsJsonAsync($"/api/v1/servers/{serverId}", new { name = "Mine now" })).StatusCode);
        var tooLong = await owner.Http.PatchAsJsonAsync($"/api/v1/servers/{serverId}", new { name = new string('x', 49) });
        Assert.Equal(HttpStatusCode.BadRequest, tooLong.StatusCode);

        var lobby = await NewTextChannelAsync(owner, serverId);
        try
        {
            var renamed = await Json(await owner.Http.PatchAsJsonAsync($"/api/v1/servers/{serverId}", new { name = "Night Hangar", joinMessageChannelId = lobby }));
            Assert.Equal("Night Hangar", renamed.GetProperty("name").GetString());
            Assert.Equal(lobby, renamed.GetProperty("joinMessageChannelId").GetGuid());
            Assert.Equal("Night Hangar", (await Json(await member.Http.GetAsync("/api/v1/auth/me"))).GetProperty("servers")[0].GetProperty("name").GetString());

            // Chosen channel gets the join message.
            var (_, joinerId) = await MemberAsync(factory, owner, serverId);
            var page = await Json(await owner.Http.GetAsync($"/api/v1/channels/{lobby}/messages?limit=5"));
            Assert.Contains(page.GetProperty("messages").EnumerateArray(),
                m => m.GetProperty("authorUserId").GetGuid() == joinerId && m.GetProperty("kind").GetString() == "memberJoined");

            // Off: nobody gets one.
            await owner.Http.PatchAsJsonAsync($"/api/v1/servers/{serverId}", new { joinMessages = false });
            var (_, quietId) = await MemberAsync(factory, owner, serverId);
            page = await Json(await owner.Http.GetAsync($"/api/v1/channels/{lobby}/messages?limit=5"));
            Assert.DoesNotContain(page.GetProperty("messages").EnumerateArray(), m => m.GetProperty("authorUserId").GetGuid() == quietId);

            var other = await owner.Http.PatchAsJsonAsync($"/api/v1/servers/{serverId}", new { joinMessageChannelId = Guid.NewGuid() });
            Assert.Equal(HttpStatusCode.BadRequest, other.StatusCode);
        }
        finally
        {
            await owner.Http.PatchAsJsonAsync($"/api/v1/servers/{serverId}", new { name, joinMessages = true, clearJoinMessageChannel = true });
        }
        var after = await Json(await owner.Http.GetAsync($"/api/v1/servers/{serverId}"));
        Assert.Equal(name, after.GetProperty("name").GetString());
        Assert.False(after.TryGetProperty("joinMessageChannelId", out var ch) && ch.ValueKind == System.Text.Json.JsonValueKind.String);
    }

    [Fact]
    public async Task Server_icon_upload_is_admin_only_and_visible_to_members()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var (member, _) = await MemberAsync(factory, owner, serverId);
        Assert.Equal(HttpStatusCode.Forbidden, (await UploadAsync(member, $"/api/v1/servers/{serverId}/icon")).StatusCode);

        var up = await UploadAsync(owner, $"/api/v1/servers/{serverId}/icon");
        Assert.Equal(HttpStatusCode.Accepted, up.StatusCode);
        var id = (await Json(up)).GetProperty("id").GetGuid();
        await FakeValidator.RunAsync(factory, width: 256, height: 256);
        var detail = await Json(await member.Http.GetAsync($"/api/v1/servers/{serverId}"));
        Assert.Equal(id, detail.GetProperty("iconAssetId").GetGuid());
        Assert.Equal(id, (await Json(await member.Http.GetAsync("/api/v1/auth/me"))).GetProperty("servers")[0].GetProperty("iconAssetId").GetGuid());
        Assert.Equal(HttpStatusCode.OK, (await member.Http.GetAsync($"/api/v1/server-icons/{id}")).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await owner.Http.DeleteAsync($"/api/v1/servers/{serverId}/icon")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await member.Http.GetAsync($"/api/v1/server-icons/{id}")).StatusCode);
    }

    private static Task<HttpResponseMessage> UploadAsync(TestClient c, string path)
    {
        var form = new MultipartFormDataContent();
        var file = new ByteArrayContent(Png);
        file.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        form.Add(file, "file", "icon.png");
        return c.Http.PostAsync(path, form);
    }
}
