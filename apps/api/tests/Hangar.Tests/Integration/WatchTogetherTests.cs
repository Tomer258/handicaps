using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.DependencyInjection;
using static Hangar.Tests.Integration.Scenario;

namespace Hangar.Tests.Integration;

/// <summary>Watch together: people in the call start and control the channel's YouTube player; others only see it.</summary>
[Collection("api")]
public class WatchTogetherTests(ApiFactory factory)
{
    [Fact]
    public async Task People_in_the_call_start_and_control_the_player()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var (member, _) = await MemberAsync(factory, owner, serverId);
        var created = await owner.Http.PostAsJsonAsync($"/api/v1/servers/{serverId}/channels", new { type = "voice", name = $"w{Guid.NewGuid():N}"[..12] });
        var voice = (await Json(created)).GetProperty("id").GetGuid();
        var watch = $"/api/v1/channels/{voice}/watch";

        Assert.Equal(HttpStatusCode.NoContent, (await member.Http.GetAsync(watch)).StatusCode);
        // Not in the call: may not start anything.
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Http.PutAsJsonAsync(watch, new { url = "https://youtu.be/dQw4w9WgXcQ" })).StatusCode);

        var join = await Json(await owner.Http.PostAsJsonAsync($"/api/v1/channels/{voice}/voice/join", new { requestId = Guid.NewGuid() }));
        var lease = join.GetProperty("leaseId").GetGuid();
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.Http.PutAsJsonAsync(watch, new { url = "https://example.com/video" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Http.PutAsJsonAsync(watch, new { playing = false })).StatusCode);

        var started = await Json(await owner.Http.PutAsJsonAsync(watch, new { url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10" }));
        Assert.Equal("dQw4w9WgXcQ", started.GetProperty("videoId").GetString());
        Assert.True(started.GetProperty("playing").GetBoolean());

        var paused = await Json(await owner.Http.PutAsJsonAsync(watch, new { playing = false, position = 42.5 }));
        Assert.False(paused.GetProperty("playing").GetBoolean());
        Assert.Equal(42.5, paused.GetProperty("position").GetDouble());
        Assert.True(paused.GetProperty("version").GetInt64() > started.GetProperty("version").GetInt64());
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.Http.PutAsJsonAsync(watch, new { position = -1 })).StatusCode);

        // Visible to everyone who can see the channel, also outside the call.
        var seen = await Json(await member.Http.GetAsync(watch));
        Assert.Equal("dQw4w9WgXcQ", seen.GetProperty("videoId").GetString());
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Http.DeleteAsync(watch)).StatusCode);

        // The call empties → the sweep ends the player.
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Http.DeleteAsync($"/api/v1/voice/{lease}")).StatusCode);
        using (var scope = factory.Services.CreateScope())
            await scope.ServiceProvider.GetRequiredService<Hangar.Api.Realtime.WatchTogetherService>().SweepAsync(CancellationToken.None);
        Assert.Equal(HttpStatusCode.NoContent, (await member.Http.GetAsync(watch)).StatusCode);
    }

    [Fact]
    public async Task A_list_of_videos_and_shorts_is_shared_and_skipped_through()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var created = await owner.Http.PostAsJsonAsync($"/api/v1/servers/{serverId}/channels", new { type = "voice", name = $"q{Guid.NewGuid():N}"[..12] });
        var voice = (await Json(created)).GetProperty("id").GetGuid();
        var watch = $"/api/v1/channels/{voice}/watch";
        await owner.Http.PostAsJsonAsync($"/api/v1/channels/{voice}/voice/join", new { requestId = Guid.NewGuid() });

        // Several links at once (new lines, spaces): one list; a /shorts/ link is marked as a Short.
        var started = await Json(await owner.Http.PutAsJsonAsync(watch, new { url = "https://youtube.com/shorts/aaaaaaaaaaa\nhttps://youtu.be/bbbbbbbbbbb" }));
        Assert.Equal(0, started.GetProperty("index").GetInt32());
        Assert.Equal("aaaaaaaaaaa", started.GetProperty("videoId").GetString());
        var queue = started.GetProperty("queue");
        Assert.Equal(2, queue.GetArrayLength());
        Assert.True(queue[0].GetProperty("short").GetBoolean());
        Assert.False(queue[1].GetProperty("short").GetBoolean());

        // One bad link names itself and changes nothing.
        var bad = await owner.Http.PutAsJsonAsync(watch, new { add = "https://youtube.com/shorts/ccccccccccc https://example.com/x" });
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.Contains("example.com", await bad.Content.ReadAsStringAsync());

        var added = await Json(await owner.Http.PutAsJsonAsync(watch, new { add = "https://youtube.com/shorts/ccccccccccc" }));
        Assert.Equal(3, added.GetProperty("queue").GetArrayLength());
        Assert.Equal(0, added.GetProperty("index").GetInt32());

        // Scrolling to the next one plays it from the start, for everyone.
        await owner.Http.PutAsJsonAsync(watch, new { playing = false, position = 30 });
        var next = await Json(await owner.Http.PutAsJsonAsync(watch, new { index = 1 }));
        Assert.Equal("bbbbbbbbbbb", next.GetProperty("videoId").GetString());
        Assert.Equal(0, next.GetProperty("position").GetDouble());
        Assert.True(next.GetProperty("playing").GetBoolean());

        // Two players report the same video ended: only the first advances.
        var first = await Json(await owner.Http.PutAsJsonAsync(watch, new { index = 2, fromIndex = 1 }));
        var second = await Json(await owner.Http.PutAsJsonAsync(watch, new { index = 3, fromIndex = 1 }));
        Assert.Equal(2, first.GetProperty("index").GetInt32());
        Assert.Equal(2, second.GetProperty("index").GetInt32());
        Assert.Equal(first.GetProperty("version").GetInt64(), second.GetProperty("version").GetInt64());

        Assert.Equal(HttpStatusCode.BadRequest, (await owner.Http.PutAsJsonAsync(watch, new { index = 3 })).StatusCode);
        var tooMany = string.Join(' ', Enumerable.Repeat("https://youtu.be/ddddddddddd", 48));
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.Http.PutAsJsonAsync(watch, new { add = tooMany })).StatusCode);
    }
}
