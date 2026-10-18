using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Hangar.Core.Media;
using Hangar.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using static Hangar.Tests.Integration.Scenario;

namespace Hangar.Tests.Integration;

/// <summary>Phase 3 acceptance: voice leases, scoped tokens, admission gate, webhooks, revocation, capacity.</summary>
[Collection("api")]
public class VoiceTests(ApiFactory factory)
{
    private LiveKitOptions Options => factory.Services.GetRequiredService<IOptions<LiveKitOptions>>().Value;

    private async Task ResetLeasesAsync()
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HangarDbContext>();
        await db.Database.ExecuteSqlRawAsync("UPDATE voice_leases SET status = 3, end_reason = 'test-reset' WHERE status IN (0, 1)");
    }

    private static Task<HttpResponseMessage> JoinAsync(TestClient c, Guid channelId, Guid? requestId = null) =>
        c.Http.PostAsJsonAsync($"/api/v1/channels/{channelId}/voice/join", new { requestId = requestId ?? Guid.NewGuid() });

    private async Task<(Guid LeaseId, string Token, string Room)> JoinOkAsync(TestClient c, Guid channelId)
    {
        var r = await JoinAsync(c, channelId);
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var j = await Json(r);
        var token = j.GetProperty("token").GetString()!;
        var verified = LiveKitTokens.Verify(token, Options.ApiKey, Options.ApiSecret, DateTimeOffset.UtcNow)!;
        return (j.GetProperty("leaseId").GetGuid(), token, verified.Video!["room"]!.GetValue<string>());
    }

    private async Task<bool> AdmitAsync(string token)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, "/internal/livekit/admission");
        req.Headers.Add("X-Forwarded-Uri", $"/rtc?access_token={Uri.EscapeDataString(token)}&auto_subscribe=1");
        var r = await factory.CreateClient().SendAsync(req);
        return r.StatusCode == HttpStatusCode.OK;
    }

    private async Task<HttpResponseMessage> WebhookAsync(object body, string? secretOverride = null)
    {
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(body));
        var jwt = LiveKitTokens.Create(Options.ApiKey, secretOverride ?? Options.ApiSecret, "", TimeSpan.FromMinutes(1), DateTimeOffset.UtcNow,
            extra: new Dictionary<string, object> { ["sha256"] = LiveKitTokens.Sha256Base64(bytes) });
        using var req = new HttpRequestMessage(HttpMethod.Post, "/internal/livekit/webhook") { Content = new ByteArrayContent(bytes) };
        req.Content.Headers.ContentType = new("application/webhook+json");
        req.Headers.TryAddWithoutValidation("Authorization", jwt);
        return await factory.CreateClient().SendAsync(req);
    }

    [Fact]
    public async Task Join_issues_room_scoped_microphone_only_token_and_switching_revokes_previous()
    {
        await ResetLeasesAsync();
        var (owner, _) = await OwnerAsync(factory);
        var lounge = await ChannelAsync(factory, "Lounge");
        var ranked = await ChannelAsync(factory, "Ranked Grind");

        var first = await JoinOkAsync(owner, lounge);
        var claims = LiveKitTokens.Verify(first.Token, Options.ApiKey, Options.ApiSecret, DateTimeOffset.UtcNow)!;
        Assert.Equal(first.LeaseId.ToString(), claims.Identity);
        var video = claims.Video!;
        Assert.True(video["roomJoin"]!.GetValue<bool>());
        Assert.False(video["canPublishData"]!.GetValue<bool>());
        Assert.Equal(["microphone"], video["canPublishSources"]!.AsArray().Select(n => n!.GetValue<string>()));
        Assert.False(video["roomAdmin"]?.GetValue<bool>() ?? false);
        Assert.True(claims.ExpiresAt < DateTimeOffset.UtcNow.AddMinutes(5));
        Assert.Equal(Options.RoomSlots, factory.LiveKit.RoomSlots[first.Room]);
        Assert.True(await AdmitAsync(first.Token));

        factory.LiveKit.Connect(first.Room, first.LeaseId.ToString());
        var second = await JoinOkAsync(owner, ranked);
        Assert.NotEqual(first.Room, second.Room);
        Assert.Contains((first.Room, first.LeaseId.ToString()), factory.LiveKit.Removed);
        Assert.False(factory.LiveKit.IsConnected(first.Room, first.LeaseId.ToString()));
        Assert.False(await AdmitAsync(first.Token));
        Assert.True(await AdmitAsync(second.Token));
    }

    [Fact]
    public async Task Server_mute_sticks_across_joins_and_disconnect_needs_permission()
    {
        await ResetLeasesAsync();
        var (owner, serverId) = await OwnerAsync(factory);
        var lounge = await ChannelAsync(factory, "Lounge");
        var (m, mId) = await MemberAsync(factory, owner, serverId);
        var (other, _) = await MemberAsync(factory, owner, serverId);
        var lease = await JoinOkAsync(m, lounge);
        factory.LiveKit.Connect(lease.Room, lease.LeaseId.ToString());
        factory.LiveKit.Publish(lease.LeaseId.ToString(), "MICROPHONE");
        Assert.Equal(HttpStatusCode.NoContent, (await m.Http.PostAsync($"/api/v1/voice/{lease.LeaseId}/confirm", null)).StatusCode);

        var mute = $"/api/v1/servers/{serverId}/members/{mId}/voice/mute";
        Assert.Equal(HttpStatusCode.Forbidden, (await other.Http.PutAsJsonAsync(mute, new { muted = true })).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Http.PutAsJsonAsync(mute, new { muted = true })).StatusCode);
        Assert.DoesNotContain("microphone", factory.LiveKit.Sources[lease.LeaseId.ToString()]);
        Assert.Contains((lease.LeaseId.ToString(), "TR_MICROPHONE", true), factory.LiveKit.MutedTracks);
        var roster = await Json(await owner.Http.GetAsync($"/api/v1/servers/{serverId}/voice"));
        Assert.Contains(roster.EnumerateArray(), v => v.GetProperty("userId").GetGuid() == mId && v.GetProperty("serverMuted").GetBoolean());

        // Leaving and rejoining does not lift it.
        factory.LiveKit.Unpublish(lease.LeaseId.ToString(), "MICROPHONE");
        Assert.Equal(HttpStatusCode.NoContent, (await m.Http.DeleteAsync($"/api/v1/voice/{lease.LeaseId}")).StatusCode);
        var again = await JoinOkAsync(m, lounge);
        var claims = LiveKitTokens.Verify(again.Token, Options.ApiKey, Options.ApiSecret, DateTimeOffset.UtcNow)!;
        Assert.Empty(claims.Video!["canPublishSources"]!.AsArray());
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Http.PutAsJsonAsync(mute, new { muted = false })).StatusCode);
        Assert.Equal(["microphone"], factory.LiveKit.Sources[again.LeaseId.ToString()]);

        // Disconnect: members cannot, the owner can; the lease is revoked so its token stops working.
        factory.LiveKit.Connect(again.Room, again.LeaseId.ToString());
        var kick = $"/api/v1/servers/{serverId}/members/{mId}/voice";
        Assert.Equal(HttpStatusCode.Forbidden, (await other.Http.DeleteAsync(kick)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Http.DeleteAsync(kick)).StatusCode);
        Assert.False(factory.LiveKit.IsConnected(again.Room, again.LeaseId.ToString()));
        Assert.False(await AdmitAsync(again.Token));
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Http.DeleteAsync(kick)).StatusCode);
    }

    [Fact]
    public async Task Join_retry_returns_same_lease_and_tampered_or_foreign_tokens_are_rejected()
    {
        await ResetLeasesAsync();
        var (owner, _) = await OwnerAsync(factory);
        var lounge = await ChannelAsync(factory, "Lounge");
        var key = Guid.NewGuid();
        var a = await Json(await JoinAsync(owner, lounge, key));
        var b = await Json(await JoinAsync(owner, lounge, key));
        Assert.Equal(a.GetProperty("leaseId").GetGuid(), b.GetProperty("leaseId").GetGuid());

        var token = a.GetProperty("token").GetString()!;
        Assert.False(await AdmitAsync(token[..^2] + (token[^2] == 'A' ? "BB" : "AA")));
        var forged = LiveKitTokens.Create(Options.ApiKey, "not-the-secret-not-the-secret-123456", a.GetProperty("leaseId").GetString()!,
            TimeSpan.FromMinutes(1), DateTimeOffset.UtcNow, new VideoGrant { RoomJoin = true, Room = "x" });
        Assert.False(await AdmitAsync(forged));
        // A correctly signed token for the right lease but a broader grant than policy issued is still denied.
        var broad = LiveKitTokens.Create(Options.ApiKey, Options.ApiSecret, a.GetProperty("leaseId").GetString()!, TimeSpan.FromMinutes(1),
            DateTimeOffset.UtcNow, new VideoGrant { RoomJoin = true, Room = (await RoomOf(a.GetProperty("leaseId").GetGuid())), CanPublish = true, CanPublishData = true, CanPublishSources = ["microphone"] });
        Assert.False(await AdmitAsync(broad));
    }

    [Fact]
    public async Task Watchdog_endpoint_reports_incomplete_reconciliation()
    {
        using var scope = factory.Services.CreateScope();
        var svc = scope.ServiceProvider.GetRequiredService<VoiceService>();
        var http = factory.CreateClient();
        try
        {
            factory.LiveKit.Down = true;
            Assert.False(await svc.ReconcileAsync(CancellationToken.None));
            var down = await http.GetAsync("/internal/watchdog/reconcile");
            Assert.Equal(HttpStatusCode.ServiceUnavailable, down.StatusCode);
            Assert.False((await Json(down)).GetProperty("healthy").GetBoolean());
        }
        finally
        {
            factory.LiveKit.Down = false;
        }
        Assert.True(await svc.ReconcileAsync(CancellationToken.None));
        var up = await http.GetAsync("/internal/watchdog/reconcile");
        Assert.Equal(HttpStatusCode.OK, up.StatusCode);
        Assert.Equal(JsonValueKind.String, (await Json(up)).GetProperty("lastSuccessAt").ValueKind);
    }

    [Fact]
    public async Task Permission_loss_blocks_join_and_admission()
    {
        await ResetLeasesAsync();
        var (owner, serverId) = await OwnerAsync(factory);
        var voice = await NewVoiceChannelAsync(owner, serverId);
        var (member, memberId) = await MemberAsync(factory, owner, serverId);

        var joined = await JoinOkAsync(member, voice);
        Assert.True(await AdmitAsync(joined.Token));

        // Deny JoinVoice (still visible) → 403 on join and the existing token stops being admitted.
        (await owner.Http.PutAsJsonAsync($"/api/v1/channels/{voice}/overrides", new { memberUserId = memberId, allow = 0, deny = 1 << 6 })).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Forbidden, (await JoinAsync(member, voice)).StatusCode);
        Assert.False(await AdmitAsync(joined.Token));

        // Reconciler revokes the live lease and removes the participant.
        factory.LiveKit.Connect(joined.Room, joined.LeaseId.ToString());
        await ReconcileAsync();
        Assert.False(factory.LiveKit.IsConnected(joined.Room, joined.LeaseId.ToString()));
        Assert.Equal(HttpStatusCode.Conflict, (await member.Http.PostAsync($"/api/v1/voice/{joined.LeaseId}/token", null)).StatusCode);

        // Hidden channel → 404, not 403.
        (await owner.Http.PutAsJsonAsync($"/api/v1/channels/{voice}/overrides", new { memberUserId = memberId, allow = 0, deny = 1 })).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.NotFound, (await JoinAsync(member, voice)).StatusCode);
    }

    [Fact]
    public async Task Leave_is_idempotent_and_ended_lease_cannot_refresh()
    {
        await ResetLeasesAsync();
        var (owner, _) = await OwnerAsync(factory);
        var lounge = await ChannelAsync(factory, "Lounge");
        var j = await JoinOkAsync(owner, lounge);
        Assert.Equal(HttpStatusCode.OK, (await owner.Http.PostAsync($"/api/v1/voice/{j.LeaseId}/token", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Http.DeleteAsync($"/api/v1/voice/{j.LeaseId}")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Http.DeleteAsync($"/api/v1/voice/{j.LeaseId}")).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await owner.Http.PostAsync($"/api/v1/voice/{j.LeaseId}/token", null)).StatusCode);
        Assert.False(await AdmitAsync(j.Token));
    }

    [Fact]
    public async Task Logout_revokes_voice_and_removes_participant()
    {
        await ResetLeasesAsync();
        var (owner, serverId) = await OwnerAsync(factory);
        var (member, _) = await MemberAsync(factory, owner, serverId);
        var j = await JoinOkAsync(member, await ChannelAsync(factory, "Lounge"));
        factory.LiveKit.Connect(j.Room, j.LeaseId.ToString());
        (await member.Http.PostAsync("/api/v1/auth/logout", null)).EnsureSuccessStatusCode();
        Assert.False(factory.LiveKit.IsConnected(j.Room, j.LeaseId.ToString()));
        Assert.False(await AdmitAsync(j.Token));
    }

    [Fact]
    public async Task Installation_human_limit_is_enforced_atomically()
    {
        await ResetLeasesAsync();
        var (owner, serverId) = await OwnerAsync(factory);
        var lounge = await ChannelAsync(factory, "Lounge");
        var members = new List<TestClient>();
        for (var i = 0; i < ApiFactory.MaxHumans + 2; i++) members.Add((await MemberAsync(factory, owner, serverId)).Client);

        var results = await Task.WhenAll(members.Select(m => JoinAsync(m, lounge)));
        Assert.Equal(ApiFactory.MaxHumans, results.Count(r => r.StatusCode == HttpStatusCode.OK));
        var rejected = results.Where(r => r.StatusCode != HttpStatusCode.OK).ToList();
        Assert.All(rejected, r => Assert.Equal(HttpStatusCode.Conflict, r.StatusCode));
        Assert.Equal("voice.full", (await Json(rejected[0])).GetProperty("code").GetString());
        await ResetLeasesAsync();
    }

    [Fact]
    public async Task Webhook_requires_signature_and_confirms_roster_membership()
    {
        await ResetLeasesAsync();
        var (owner, serverId) = await OwnerAsync(factory);
        var lounge = await ChannelAsync(factory, "Lounge");
        var j = await JoinOkAsync(owner, lounge);
        var me = (await Json(await owner.Http.GetAsync("/api/v1/auth/me"))).GetProperty("user").GetProperty("id").GetGuid();
        var body = new { @event = "participant_joined", room = new { name = j.Room }, participant = new { identity = j.LeaseId.ToString() } };

        // Not visible until LiveKit confirms.
        var roster = await Json(await owner.Http.GetAsync($"/api/v1/servers/{serverId}/voice"));
        Assert.DoesNotContain(roster.EnumerateArray(), m => m.GetProperty("userId").GetGuid() == me);

        Assert.Equal(HttpStatusCode.Unauthorized, (await WebhookAsync(body, "wrong-secret-wrong-secret-wrong-secret")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await WebhookAsync(body)).StatusCode);
        roster = await Json(await owner.Http.GetAsync($"/api/v1/servers/{serverId}/voice"));
        var row = roster.EnumerateArray().Single(m => m.GetProperty("userId").GetGuid() == me);
        Assert.Equal(lounge, row.GetProperty("channelId").GetGuid());

        // A joined event for an unknown identity in a managed room is kicked.
        var stranger = Guid.NewGuid().ToString();
        factory.LiveKit.Connect(j.Room, stranger);
        await WebhookAsync(new { @event = "participant_joined", room = new { name = j.Room }, participant = new { identity = stranger } });
        Assert.False(factory.LiveKit.IsConnected(j.Room, stranger));
    }

    [Fact]
    public async Task Confirm_is_verified_with_livekit_and_unconfirmed_leases_expire()
    {
        await ResetLeasesAsync();
        var (owner, serverId) = await OwnerAsync(factory);
        var j = await JoinOkAsync(owner, await ChannelAsync(factory, "Movie Night"));

        // Claim without presence → stays unconfirmed.
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Http.PostAsync($"/api/v1/voice/{j.LeaseId}/confirm", null)).StatusCode);
        Assert.Empty((await Json(await owner.Http.GetAsync($"/api/v1/servers/{serverId}/voice"))).EnumerateArray());

        factory.LiveKit.Connect(j.Room, j.LeaseId.ToString());
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Http.PostAsync($"/api/v1/voice/{j.LeaseId}/confirm", null)).StatusCode);
        Assert.Single((await Json(await owner.Http.GetAsync($"/api/v1/servers/{serverId}/voice"))).EnumerateArray());

        // Unconfirmed past the grace window → ended by the reconciler.
        var k = await JoinOkAsync(owner, await ChannelAsync(factory, "AFK"));
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HangarDbContext>();
            await db.Database.ExecuteSqlInterpolatedAsync($"UPDATE voice_leases SET created_at = now() - interval '10 minutes', last_confirmed_at = now() - interval '10 minutes' WHERE id = {k.LeaseId}");
        }
        await ReconcileAsync();
        Assert.False(await AdmitAsync(k.Token));
    }

    private static Task<HttpResponseMessage> ReserveAsync(TestClient c, Guid leaseId, string kind, object? body = null) =>
        c.Http.PostAsJsonAsync($"/api/v1/voice/{leaseId}/publications/{kind}", body ?? new { quality = "1080p60", withAudio = true });

    [Fact]
    public async Task Screen_reservations_grant_sources_per_participant_and_enforce_the_installation_limit()
    {
        await ResetLeasesAsync();
        var (owner, serverId) = await OwnerAsync(factory);
        var lounge = await ChannelAsync(factory, "Lounge");
        var people = new List<(TestClient Client, Guid LeaseId)>();
        for (var i = 0; i < ApiFactory.MaxScreens + 1; i++)
        {
            var (c, _) = await MemberAsync(factory, owner, serverId);
            people.Add((c, (await JoinOkAsync(c, lounge)).LeaseId));
        }

        for (var i = 0; i < ApiFactory.MaxScreens; i++)
            Assert.Equal(HttpStatusCode.OK, (await ReserveAsync(people[i].Client, people[i].LeaseId, "screen")).StatusCode);
        Assert.Equal(["microphone", "screen_share", "screen_share_audio"], factory.LiveKit.Sources[people[0].LeaseId.ToString()]);

        // Idempotent for the same lease; the next person is over the limit.
        Assert.Equal(HttpStatusCode.OK, (await ReserveAsync(people[0].Client, people[0].LeaseId, "screen")).StatusCode);
        var over = await ReserveAsync(people[^1].Client, people[^1].LeaseId, "screen");
        Assert.Equal(HttpStatusCode.Conflict, over.StatusCode);
        Assert.Equal("media.limit", (await Json(over)).GetProperty("code").GetString());
        Assert.False(factory.LiveKit.Sources.ContainsKey(people[^1].LeaseId.ToString()));

        // Releasing removes the source (LiveKit then unpublishes) and frees the slot.
        Assert.Equal(HttpStatusCode.NoContent, (await people[0].Client.Http.DeleteAsync($"/api/v1/voice/{people[0].LeaseId}/publications/screen")).StatusCode);
        Assert.Equal(["microphone"], factory.LiveKit.Sources[people[0].LeaseId.ToString()]);
        Assert.Equal(HttpStatusCode.OK, (await ReserveAsync(people[^1].Client, people[^1].LeaseId, "screen", new { quality = "720p30", withAudio = false })).StatusCode);
        Assert.Equal(["microphone", "screen_share"], factory.LiveKit.Sources[people[^1].LeaseId.ToString()]);

        // Ending the lease releases its reservation.
        await people[1].Client.Http.DeleteAsync($"/api/v1/voice/{people[1].LeaseId}");
        Assert.Equal(HttpStatusCode.OK, (await ReserveAsync(people[0].Client, people[0].LeaseId, "screen")).StatusCode);
        await ResetLeasesAsync();
    }

    [Fact]
    public async Task Publication_requires_permission_and_unpublished_reservation_expires()
    {
        await ResetLeasesAsync();
        var (owner, serverId) = await OwnerAsync(factory);
        var voice = await NewVoiceChannelAsync(owner, serverId);
        var (member, memberId) = await MemberAsync(factory, owner, serverId);
        var j = await JoinOkAsync(member, voice);
        factory.LiveKit.Connect(j.Room, j.LeaseId.ToString());

        (await owner.Http.PutAsJsonAsync($"/api/v1/channels/{voice}/overrides", new { memberUserId = memberId, allow = 0, deny = 1 << 9 })).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Forbidden, (await ReserveAsync(member, j.LeaseId, "screen")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await ReserveAsync(member, j.LeaseId, "camera")).StatusCode);
        Assert.Contains("camera", factory.LiveKit.Sources[j.LeaseId.ToString()]);

        // Never published within the window → the reconciler releases it and withdraws the grant.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HangarDbContext>();
            await db.Database.ExecuteSqlInterpolatedAsync($"UPDATE media_publication_reservations SET expires_at = now() - interval '1 minute' WHERE voice_lease_id = {j.LeaseId}");
        }
        await ReconcileAsync();
        Assert.DoesNotContain("camera", factory.LiveKit.Sources[j.LeaseId.ToString()]);
    }

    [Fact]
    public async Task Track_webhooks_drive_roster_flags_and_unpublish_releases()
    {
        await ResetLeasesAsync();
        var (owner, serverId) = await OwnerAsync(factory);
        var lounge = await ChannelAsync(factory, "Lounge");
        var j = await JoinOkAsync(owner, lounge);
        var participant = new { identity = j.LeaseId.ToString() };
        var room = new { name = j.Room };
        await WebhookAsync(new { @event = "participant_joined", room, participant });
        Assert.Equal(HttpStatusCode.OK, (await ReserveAsync(owner, j.LeaseId, "screen")).StatusCode);

        await WebhookAsync(new { @event = "track_published", room, participant, track = new { sid = "TR_1", source = "SCREEN_SHARE" } });
        var row = (await Json(await owner.Http.GetAsync($"/api/v1/servers/{serverId}/voice"))).EnumerateArray().Single();
        Assert.True(row.GetProperty("screen").GetBoolean());

        await WebhookAsync(new { @event = "track_unpublished", room, participant, track = new { sid = "TR_1", source = "SCREEN_SHARE" } });
        row = (await Json(await owner.Http.GetAsync($"/api/v1/servers/{serverId}/voice"))).EnumerateArray().Single();
        Assert.False(row.GetProperty("screen").GetBoolean());
        Assert.DoesNotContain("screen_share", factory.LiveKit.Sources[j.LeaseId.ToString()]);
    }

    [Fact]
    public async Task Stale_participant_left_does_not_resurrect_a_lease_ended_meanwhile()
    {
        await ResetLeasesAsync();
        var (owner, _) = await OwnerAsync(factory);
        var lounge = await ChannelAsync(factory, "Lounge");
        var ranked = await ChannelAsync(factory, "Ranked Grind");
        var j = await JoinOkAsync(owner, lounge);
        var participant = new { identity = j.LeaseId.ToString() };
        await WebhookAsync(new { @event = "participant_joined", room = new { name = j.Room }, participant });

        // Scope A snapshots the lease while Active (as an in-flight webhook would) ...
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HangarDbContext>();
        Assert.Equal(VoiceLeaseStatus.Active, (await db.VoiceLeases.FirstAsync(l => l.Id == j.LeaseId)).Status);
        // ... the user leaves meanwhile ...
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Http.DeleteAsync($"/api/v1/voice/{j.LeaseId}")).StatusCode);
        // ... and the late participant_left is handled with the stale snapshot.
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { @event = "participant_left", room = new { name = j.Room }, participant }));
        var jwt = LiveKitTokens.Create(Options.ApiKey, Options.ApiSecret, "", TimeSpan.FromMinutes(1), DateTimeOffset.UtcNow,
            extra: new Dictionary<string, object> { ["sha256"] = LiveKitTokens.Sha256Base64(bytes) });
        Assert.True(await scope.ServiceProvider.GetRequiredService<VoiceService>().HandleWebhookAsync(jwt, bytes, CancellationToken.None));

        using var check = factory.Services.CreateScope();
        var status = await check.ServiceProvider.GetRequiredService<HangarDbContext>().VoiceLeases
            .Where(l => l.Id == j.LeaseId).Select(l => l.Status).FirstAsync();
        Assert.Equal(VoiceLeaseStatus.Ended, status);
        await JoinOkAsync(owner, ranked); // would hit ux_voice_leases_one_active if the lease were resurrected
    }

    private async Task ReconcileAsync()
    {
        using var scope = factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<VoiceService>().ReconcileAsync(CancellationToken.None);
    }

    private async Task<string> RoomOf(Guid leaseId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HangarDbContext>();
        return await db.VoiceLeases.Where(l => l.Id == leaseId).Select(l => l.RoomName).FirstAsync();
    }

    private static async Task<Guid> NewVoiceChannelAsync(TestClient owner, Guid serverId)
    {
        var r = await owner.Http.PostAsJsonAsync($"/api/v1/servers/{serverId}/channels", new { type = "voice", name = $"v{Guid.NewGuid():N}"[..12] });
        r.EnsureSuccessStatusCode();
        return (await Json(r)).GetProperty("id").GetGuid();
    }
}
