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
}
