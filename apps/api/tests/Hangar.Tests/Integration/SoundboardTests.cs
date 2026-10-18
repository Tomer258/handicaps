using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Hangar.Core.Files;
using Hangar.Core.Media;
using Hangar.Core.Persistence;
using Hangar.Core.Soundboard;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using static Hangar.Tests.Integration.Scenario;

namespace Hangar.Tests.Integration;

/// <summary>Phase 5 acceptance: upload + validation hand-off, catalog/favorites/preview, authorized playback and limits.</summary>
[Collection("api")]
public class SoundboardTests(ApiFactory factory)
{
    private string StorageRoot => factory.Services.GetRequiredService<IOptions<StorageOptions>>().Value.Root;
    private LiveKitOptions LiveKitOptions => factory.Services.GetRequiredService<IOptions<LiveKitOptions>>().Value;

    private async Task ResetAsync()
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HangarDbContext>();
        await db.Database.ExecuteSqlRawAsync("UPDATE voice_leases SET status = 3, end_reason = 'test-reset' WHERE status IN (0, 1)");
        await db.Database.ExecuteSqlRawAsync("DELETE FROM sound_playback_commands");
        factory.Publisher.AckState = "playing";
        factory.Publisher.Active.Clear();
    }

    /// <summary>Canonical 48 kHz stereo 16-bit PCM WAV with a quiet sine.</summary>
    private static byte[] Wav(int ms = 800)
    {
        var frames = 48 * ms;
        using var m = new MemoryStream();
        using var w = new BinaryWriter(m);
        w.Write("RIFF"u8); w.Write(36 + frames * 4); w.Write("WAVE"u8);
        w.Write("fmt "u8); w.Write(16); w.Write((short)1); w.Write((short)2); w.Write(48000); w.Write(48000 * 4); w.Write((short)4); w.Write((short)16);
        w.Write("data"u8); w.Write(frames * 4);
        for (var i = 0; i < frames; i++)
        {
            var s = (short)(Math.Sin(i * 2 * Math.PI * 440 / 48000) * 3000);
            w.Write(s); w.Write(s);
        }
        return m.ToArray();
    }

    private static Task<HttpResponseMessage> UploadAsync(TestClient c, Guid serverId, string name, byte[] bytes, string fileName = "s.wav")
    {
        var form = new MultipartFormDataContent { { new StringContent(name), "name" } };
        var file = new ByteArrayContent(bytes);
        file.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        form.Add(file, "file", fileName);
        return c.Http.PostAsync($"/api/v1/servers/{serverId}/sounds", form);
    }

    /// <summary>Plays the validator's role: copies the (already canonical) input to the job's output and reports ok/error.</summary>
    private async Task ValidateAllAsync(string? error = null)
    {
        var jobs = Path.Combine(StorageRoot, "spool", "jobs");
        foreach (var path in Directory.GetFiles(jobs, "*.json"))
        {
            var job = JsonDocument.Parse(await File.ReadAllTextAsync(path)).RootElement;
            var id = job.GetProperty("jobId").GetString()!;
            if (error is null)
                File.Copy(Path.Combine(StorageRoot, job.GetProperty("input").GetString()!), Path.Combine(StorageRoot, job.GetProperty("output").GetString()!), true);
            File.Delete(path);
            await File.WriteAllTextAsync(Path.Combine(StorageRoot, "spool", "results", $"{id}.json"),
                JsonSerializer.Serialize(new { jobId = id, ok = error is null, error }));
        }
        using var scope = factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<SoundboardService>().CollectAsync(CancellationToken.None);
    }

    private async Task<Guid> ReadySoundAsync(TestClient c, Guid serverId, string? name = null)
    {
        var r = await UploadAsync(c, serverId, name ?? $"s{Guid.NewGuid():N}"[..10], Wav());
        Assert.Equal(HttpStatusCode.Created, r.StatusCode);
        await ValidateAllAsync();
        return (await Json(r)).GetProperty("id").GetGuid();
    }

    private async Task<Guid> ActiveLeaseAsync(TestClient c, Guid channelId)
    {
        var r = await c.Http.PostAsJsonAsync($"/api/v1/channels/{channelId}/voice/join", new { requestId = Guid.NewGuid() });
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var leaseId = (await Json(r)).GetProperty("leaseId").GetGuid();
        using (var scope = factory.Services.CreateScope())
        {
            var room = await scope.ServiceProvider.GetRequiredService<HangarDbContext>().VoiceLeases.Where(l => l.Id == leaseId).Select(l => l.RoomName).FirstAsync();
            factory.LiveKit.Connect(room, leaseId.ToString());
        }
        Assert.Equal(HttpStatusCode.NoContent, (await c.Http.PostAsync($"/api/v1/voice/{leaseId}/confirm", null)).StatusCode);
        return leaseId;
    }

    private static Task<HttpResponseMessage> PlayAsync(TestClient c, Guid channelId, Guid leaseId, Guid soundId, Guid? requestId = null) =>
        c.Http.PostAsJsonAsync($"/api/v1/channels/{channelId}/sound-plays", new { requestId = requestId ?? Guid.NewGuid(), voiceLeaseId = leaseId, soundId });

    private async Task<HttpResponseMessage> WorkerEventAsync(string playbackId, string state, string? key = ApiFactory.WorkerKey, long epoch = FakeSoundPublisher.Epoch)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, "/internal/soundboard/events")
        {
            Content = JsonContent.Create(new { playbackId, epoch, state, code = (string?)null }),
        };
        if (key is not null) req.Headers.Add("X-Hangar-Worker-Key", key);
        return await factory.CreateClient().SendAsync(req);
    }

    private async Task<PlaybackState> StateAsync(Guid playbackId)
    {
        using var scope = factory.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<HangarDbContext>().SoundPlaybackCommands.Where(c => c.Id == playbackId).Select(c => c.State).FirstAsync();
    }

    [Fact]
    public async Task Upload_is_pending_until_validated_then_ready_for_everyone_with_favorites_and_preview()
    {
        await ResetAsync();
        var (owner, serverId) = await OwnerAsync(factory);
        var (member, _) = await MemberAsync(factory, owner, serverId);
        var name = $"airhorn{Guid.NewGuid():N}"[..14];

        var r = await UploadAsync(owner, serverId, name, Wav());
        Assert.Equal(HttpStatusCode.Created, r.StatusCode);
        var sound = await Json(r);
        var id = sound.GetProperty("id").GetGuid();
        Assert.Equal("pending", sound.GetProperty("state").GetString());
        // Pending sounds are visible only to their uploader.
        Assert.DoesNotContain((await Json(await member.Http.GetAsync($"/api/v1/servers/{serverId}/sounds"))).GetProperty("sounds").EnumerateArray(),
            s => s.GetProperty("id").GetGuid() == id);

        await ValidateAllAsync();
        var catalog = await Json(await member.Http.GetAsync($"/api/v1/servers/{serverId}/sounds"));
        var seen = catalog.GetProperty("sounds").EnumerateArray().Single(s => s.GetProperty("id").GetGuid() == id);
        Assert.Equal("ready", seen.GetProperty("state").GetString());
        Assert.Equal(800, seen.GetProperty("durationMs").GetInt32());
        Assert.False(seen.GetProperty("canManage").GetBoolean());
        Assert.True(catalog.GetProperty("canUpload").GetBoolean());

        Assert.Equal(HttpStatusCode.NoContent, (await member.Http.PutAsync($"/api/v1/sounds/{id}/favorite", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await member.Http.PutAsync($"/api/v1/sounds/{id}/favorite", null)).StatusCode);
        Assert.True((await Json(await member.Http.GetAsync($"/api/v1/servers/{serverId}/sounds"))).GetProperty("sounds").EnumerateArray()
            .Single(s => s.GetProperty("id").GetGuid() == id).GetProperty("favorite").GetBoolean());

        var preview = await member.Http.GetAsync($"/api/v1/sounds/{id}/preview");
        Assert.Equal(HttpStatusCode.OK, preview.StatusCode);
        Assert.Equal("audio/wav", preview.Content.Headers.ContentType!.MediaType);
        Assert.Equal(Wav().Length, (await preview.Content.ReadAsByteArrayAsync()).Length);

        // Members manage only their own sounds; the owner (ManageAnySounds) can rename and delete.
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Http.DeleteAsync($"/api/v1/sounds/{id}")).StatusCode);
        var renamed = await owner.Http.PatchAsJsonAsync($"/api/v1/sounds/{id}", new { name = "Air horn", emoji = "📯" });
        Assert.Equal(HttpStatusCode.OK, renamed.StatusCode);
        Assert.Equal("📯", (await Json(renamed)).GetProperty("emoji").GetString());
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Http.DeleteAsync($"/api/v1/sounds/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await member.Http.GetAsync($"/api/v1/sounds/{id}/preview")).StatusCode);
    }

    [Fact]
    public async Task Upload_rejects_non_audio_and_bad_input_and_validator_errors_reject_the_sound()
    {
        await ResetAsync();
        var (owner, serverId) = await OwnerAsync(factory);

        var notAudio = await UploadAsync(owner, serverId, "pdf", "%PDF-1.7 not audio"u8.ToArray(), "x.mp3");
        Assert.Equal(HttpStatusCode.UnprocessableEntity, notAudio.StatusCode);
        Assert.Equal("sound.unsupported", (await Json(notAudio)).GetProperty("code").GetString());
        Assert.Equal(HttpStatusCode.BadRequest, (await UploadAsync(owner, serverId, "", Wav())).StatusCode);
        Assert.Empty(Directory.GetFiles(Path.Combine(StorageRoot, "quarantine")));

        var r = await UploadAsync(owner, serverId, "quiet", Wav());
        var id = (await Json(r)).GetProperty("id").GetGuid();
        await ValidateAllAsync(error: "silent");
        var mine = (await Json(await owner.Http.GetAsync($"/api/v1/servers/{serverId}/sounds"))).GetProperty("sounds").EnumerateArray()
            .Single(s => s.GetProperty("id").GetGuid() == id);
        Assert.Equal("rejected", mine.GetProperty("state").GetString());
        Assert.Equal("silent", mine.GetProperty("rejectReason").GetString());
        Assert.Empty(Directory.GetFiles(Path.Combine(StorageRoot, "quarantine")));
    }

    [Fact]
    public async Task Play_requires_an_active_lease_in_that_channel_and_sends_an_allowlisted_scoped_command()
    {
        await ResetAsync();
        var (owner, serverId) = await OwnerAsync(factory);
        var lounge = await ChannelAsync(factory, "Lounge");
        var ranked = await ChannelAsync(factory, "Ranked Grind");
        var soundId = await ReadySoundAsync(owner, serverId);
        var (member, memberId) = await MemberAsync(factory, owner, serverId);

        var notInVoice = await PlayAsync(member, lounge, Guid.NewGuid(), soundId);
        Assert.Equal(HttpStatusCode.Conflict, notInVoice.StatusCode);
        Assert.Equal("sound.not_in_voice", (await Json(notInVoice)).GetProperty("code").GetString());

        var lease = await ActiveLeaseAsync(member, lounge);
        Assert.Equal(HttpStatusCode.Conflict, (await PlayAsync(member, ranked, lease, soundId)).StatusCode); // lease is for another channel
        Assert.Equal(HttpStatusCode.Conflict, (await PlayAsync(owner, lounge, lease, soundId)).StatusCode);  // someone else's lease

        factory.Publisher.Plays.Clear();
        var requestId = Guid.NewGuid();
        var ok = await PlayAsync(member, lounge, lease, soundId, requestId);
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        var play = await Json(ok);
        Assert.Equal("playing", play.GetProperty("state").GetString());
        Assert.Equal(memberId, play.GetProperty("actorUserId").GetGuid());

        var cmd = Assert.Single(factory.Publisher.Plays);
        Assert.Matches("^sounds/[0-9a-f]{32}\\.wav$", cmd.File);
        Assert.Equal(64, cmd.Sha256.Length);
        Assert.Equal(memberId.ToString(), cmd.Actor);
        var claims = LiveKitTokens.Verify(cmd.Token, LiveKitOptions.ApiKey, LiveKitOptions.ApiSecret, DateTimeOffset.UtcNow)!;
        Assert.Equal(VoiceService.PublisherIdentityPrefix + cmd.Room, claims.Identity);
        Assert.Equal(cmd.Room, claims.Video!["room"]!.GetValue<string>());
        Assert.False(claims.Video["canSubscribe"]!.GetValue<bool>());
        Assert.False(claims.Video["canPublishData"]!.GetValue<bool>());

        // A retried request returns the same playback without a second command.
        var retry = await PlayAsync(member, lounge, lease, soundId, requestId);
        Assert.Equal(play.GetProperty("playbackId").GetGuid(), (await Json(retry)).GetProperty("playbackId").GetGuid());
        Assert.Single(factory.Publisher.Plays);

        // One effect per actor at a time (past the cooldown, which is checked first).
        using (var scope = factory.Services.CreateScope())
            await scope.ServiceProvider.GetRequiredService<HangarDbContext>().Database
                .ExecuteSqlRawAsync("UPDATE sound_playback_commands SET accepted_at = accepted_at - interval '3 seconds'");
        var busy = await PlayAsync(member, lounge, lease, soundId);
        Assert.Equal(HttpStatusCode.Conflict, busy.StatusCode);
        Assert.Equal("sound.busy_actor", (await Json(busy)).GetProperty("code").GetString());

        var active = await Json(await owner.Http.GetAsync($"/api/v1/channels/{lounge}/sound-plays"));
        Assert.Single(active.EnumerateArray());
    }

    [Fact]
    public async Task Worker_events_need_the_key_and_matching_epoch_then_cooldown_applies()
    {
        await ResetAsync();
        var (owner, serverId) = await OwnerAsync(factory);
        var lounge = await ChannelAsync(factory, "Lounge");
        var soundId = await ReadySoundAsync(owner, serverId);
        var (member, _) = await MemberAsync(factory, owner, serverId);
        var lease = await ActiveLeaseAsync(member, lounge);

        var playbackId = (await Json(await PlayAsync(member, lounge, lease, soundId))).GetProperty("playbackId").GetString()!;
        Assert.Equal(HttpStatusCode.Unauthorized, (await WorkerEventAsync(playbackId, "completed", key: null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await WorkerEventAsync(playbackId, "completed", key: "wrong-key-0123456789abcdef")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await WorkerEventAsync(playbackId, "completed", epoch: 7)).StatusCode);
        Assert.Equal(PlaybackState.Playing, await StateAsync(Guid.Parse(playbackId)));   // stale worker epoch ignored

        Assert.Equal(HttpStatusCode.OK, (await WorkerEventAsync(playbackId, "completed")).StatusCode);
        Assert.Equal(PlaybackState.Completed, await StateAsync(Guid.Parse(playbackId)));
        Assert.Equal(HttpStatusCode.OK, (await WorkerEventAsync(playbackId, "failed")).StatusCode);
        Assert.Equal(PlaybackState.Completed, await StateAsync(Guid.Parse(playbackId))); // terminal states never change

        var tooSoon = await PlayAsync(member, lounge, lease, soundId);
        Assert.Equal(HttpStatusCode.TooManyRequests, tooSoon.StatusCode);
        Assert.Equal("sound.cooldown", (await Json(tooSoon)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task Unreachable_worker_fails_closed_and_is_never_retried()
    {
        await ResetAsync();
        var (owner, serverId) = await OwnerAsync(factory);
        var lounge = await ChannelAsync(factory, "Lounge");
        var soundId = await ReadySoundAsync(owner, serverId);
        var (member, _) = await MemberAsync(factory, owner, serverId);
        var lease = await ActiveLeaseAsync(member, lounge);

        factory.Publisher.AckState = null;
        factory.Publisher.Stops.Clear();
        var r = await PlayAsync(member, lounge, lease, soundId);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, r.StatusCode);
        Assert.Equal("sound.unavailable", (await Json(r)).GetProperty("code").GetString());
        var cmd = factory.Publisher.Plays.Last();
        Assert.Contains(cmd.PlaybackId, factory.Publisher.Stops); // make sure nothing starts late
        Assert.Equal(PlaybackState.Failed, await StateAsync(Guid.Parse(cmd.PlaybackId)));
    }

    [Fact]
    public async Task Stop_is_limited_to_own_sounds_unless_moderator_and_reconcile_stops_plays_of_actors_who_left()
    {
        await ResetAsync();
        var (owner, serverId) = await OwnerAsync(factory);
        var lounge = await ChannelAsync(factory, "Lounge");
        var soundId = await ReadySoundAsync(owner, serverId);
        var (a, _) = await MemberAsync(factory, owner, serverId, "a");
        var (b, _) = await MemberAsync(factory, owner, serverId, "b");
        var leaseA = await ActiveLeaseAsync(a, lounge);
        var leaseB = await ActiveLeaseAsync(b, lounge);

        var pa = (await Json(await PlayAsync(a, lounge, leaseA, soundId))).GetProperty("playbackId").GetGuid();
        Assert.Equal(HttpStatusCode.Forbidden, (await b.Http.DeleteAsync($"/api/v1/sound-plays/{pa}")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await b.Http.PostAsync($"/api/v1/channels/{lounge}/sound-stop-all", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await a.Http.DeleteAsync($"/api/v1/sound-plays/{pa}")).StatusCode);
        Assert.Equal(PlaybackState.Stopped, await StateAsync(pa));
        Assert.Contains(pa.ToString(), factory.Publisher.Stops);

        var pb = (await Json(await PlayAsync(b, lounge, leaseB, soundId))).GetProperty("playbackId").GetGuid();
        var stopAll = await owner.Http.PostAsync($"/api/v1/channels/{lounge}/sound-stop-all", null);
        Assert.Equal(1, (await Json(stopAll)).GetProperty("stopped").GetInt32());
        Assert.Equal(PlaybackState.Stopped, await StateAsync(pb));

        // A plays again (past the cooldown), then leaves voice: the reconciler stops the effect.
        await Task.Delay(TimeSpan.FromSeconds(2.1));
        var again = (await Json(await PlayAsync(a, lounge, leaseA, soundId))).GetProperty("playbackId").GetGuid();
        Assert.Equal(HttpStatusCode.NoContent, (await a.Http.DeleteAsync($"/api/v1/voice/{leaseA}")).StatusCode);
        using (var scope = factory.Services.CreateScope())
            await scope.ServiceProvider.GetRequiredService<SoundPlaybackService>().ReconcileAsync(CancellationToken.None);
        Assert.Equal(PlaybackState.Stopped, await StateAsync(again));
        using (var scope = factory.Services.CreateScope())
            Assert.Equal("actor_left", await scope.ServiceProvider.GetRequiredService<HangarDbContext>().SoundPlaybackCommands
                .Where(c => c.Id == again).Select(c => c.FailureCode).FirstAsync());
    }
}
