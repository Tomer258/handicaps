using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Hangar.Core.Identity;
using Hangar.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Hangar.Tests.Integration;

[CollectionDefinition("api")]
public class ApiCollection : ICollectionFixture<ApiFactory>;

/// <summary>Phase 1 acceptance: invitations, login, sessions, CSRF/Origin, revocation.</summary>
[Collection("api")]
public class AuthTests(ApiFactory factory)
{
    private static async Task<JsonElement> Json(HttpResponseMessage r) =>
        JsonDocument.Parse(await r.Content.ReadAsStringAsync()).RootElement;

    private async Task<(TestClient Owner, Guid ServerId)> EnsureOwnerAsync()
    {
        var owner = factory.NewClient();
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HangarDbContext>();
        var server = await db.Servers.FirstAsync();
        if (server.OwnerUserId is null)
        {
            var secret = await factory.OwnerBootstrapSecretAsync();
            (await owner.RegisterAsync(secret, "owner")).EnsureSuccessStatusCode();
        }
        else
        {
            (await owner.LoginAsync("owner")).EnsureSuccessStatusCode();
        }
        return (owner, server.Id);
    }

    private static async Task<string> CreateInviteAsync(TestClient owner, Guid serverId, int maxUses = 1)
    {
        var r = await owner.Http.PostAsJsonAsync($"/api/v1/servers/{serverId}/invitations", new { maxUses });
        r.EnsureSuccessStatusCode();
        return (await Json(r)).GetProperty("secret").GetString()!;
    }

    [Fact]
    public async Task Owner_bootstrap_then_member_registration_and_me()
    {
        var (owner, serverId) = await EnsureOwnerAsync();
        var me = await Json(await owner.Http.GetAsync("/api/v1/auth/me"));
        Assert.True(me.GetProperty("servers")[0].GetProperty("isOwner").GetBoolean());

        var secret = await CreateInviteAsync(owner, serverId);
        var member = factory.NewClient();
        var reg = await member.RegisterAsync(secret, "maya" + Random.Shared.Next(1000, 9999), displayName: "Maya");
        Assert.Equal(HttpStatusCode.OK, reg.StatusCode);
        var detail = await Json(await member.Http.GetAsync($"/api/v1/servers/{serverId}"));
        Assert.True(detail.GetProperty("channels").GetArrayLength() >= 8);
    }

    [Fact]
    public async Task Reused_invitation_fails()
    {
        var (owner, serverId) = await EnsureOwnerAsync();
        var secret = await CreateInviteAsync(owner, serverId);
        Assert.Equal(HttpStatusCode.OK, (await factory.NewClient().RegisterAsync(secret, "first" + Random.Shared.Next(1000, 9999))).StatusCode);
        var second = await factory.NewClient().RegisterAsync(secret, "second" + Random.Shared.Next(1000, 9999));
        Assert.Equal(HttpStatusCode.BadRequest, second.StatusCode);
        Assert.Equal("invite.invalid", (await Json(second)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task Expired_invitation_fails()
    {
        var (owner, serverId) = await EnsureOwnerAsync();
        var secret = await CreateInviteAsync(owner, serverId);
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HangarDbContext>();
            var hash = Hangar.Core.Common.Secrets.Sha256Hex(secret);
            await db.Invitations.Where(i => i.TokenHash == hash)
                .ExecuteUpdateAsync(s => s.SetProperty(i => i.ExpiresAt, DateTimeOffset.UtcNow.AddMinutes(-1)));
        }
        var r = await factory.NewClient().RegisterAsync(secret, "late" + Random.Shared.Next(1000, 9999));
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
    }

    [Fact]
    public async Task Concurrent_redemption_never_exceeds_max_uses()
    {
        var (owner, serverId) = await EnsureOwnerAsync();
        var secret = await CreateInviteAsync(owner, serverId, maxUses: 2);
        var tasks = Enumerable.Range(0, 6)
            .Select(i => factory.NewClient().RegisterAsync(secret, $"race{i}x{Random.Shared.Next(1000, 9999)}"))
            .ToArray();
        var results = await Task.WhenAll(tasks);
        Assert.Equal(2, results.Count(r => r.StatusCode == HttpStatusCode.OK));
    }

    [Fact]
    public async Task Login_name_is_case_insensitive_and_unique()
    {
        var (owner, serverId) = await EnsureOwnerAsync();
        var name = "Dana" + Random.Shared.Next(1000, 9999);
        Assert.Equal(HttpStatusCode.OK, (await factory.NewClient().RegisterAsync(await CreateInviteAsync(owner, serverId), name)).StatusCode);
        var dup = await factory.NewClient().RegisterAsync(await CreateInviteAsync(owner, serverId), name.ToLowerInvariant());
        Assert.Equal(HttpStatusCode.Conflict, dup.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await factory.NewClient().LoginAsync(name.ToUpperInvariant())).StatusCode);
    }

    [Fact]
    public async Task Wrong_password_and_unknown_login_look_identical()
    {
        await EnsureOwnerAsync();
        var a = await factory.NewClient().LoginAsync("owner", "wrong password!!");
        var b = await factory.NewClient().LoginAsync("nobody-here", "wrong password!!");
        Assert.Equal(HttpStatusCode.Unauthorized, a.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, b.StatusCode);
        Assert.Equal((await Json(a)).GetProperty("code").GetString(), (await Json(b)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task Missing_csrf_header_is_rejected()
    {
        var (owner, serverId) = await EnsureOwnerAsync();
        owner.Handler.SendXsrf = false;
        var r = await owner.Http.PostAsJsonAsync($"/api/v1/servers/{serverId}/invitations", new { maxUses = 1 });
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal("csrf.invalid", (await Json(r)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task Cross_origin_unsafe_request_is_rejected()
    {
        var (owner, serverId) = await EnsureOwnerAsync();
        owner.Handler.OriginOverride = "https://evil.example";
        var r = await owner.Http.PostAsJsonAsync($"/api/v1/servers/{serverId}/invitations", new { maxUses = 1 });
        Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
    }

    [Fact]
    public async Task Revoked_session_blocks_http_immediately()
    {
        var (owner, serverId) = await EnsureOwnerAsync();
        var login = "revokee" + Random.Shared.Next(1000, 9999);
        var victim = factory.NewClient();
        (await victim.RegisterAsync(await CreateInviteAsync(owner, serverId), login)).EnsureSuccessStatusCode();

        var other = factory.NewClient();
        (await other.LoginAsync(login)).EnsureSuccessStatusCode();
        var sessions = await Json(await other.Http.GetAsync("/api/v1/auth/sessions"));
        var victimSession = sessions.EnumerateArray().First(s => !s.GetProperty("current").GetBoolean()).GetProperty("id").GetString();

        Assert.Equal(HttpStatusCode.NoContent, (await other.Http.DeleteAsync($"/api/v1/auth/sessions/{victimSession}")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await victim.Http.GetAsync("/api/v1/auth/me")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await other.Http.GetAsync("/api/v1/auth/me")).StatusCode);
    }

    [Fact]
    public async Task Logout_invalidates_cookie_server_side()
    {
        var (owner, serverId) = await EnsureOwnerAsync();
        var c = factory.NewClient();
        (await c.RegisterAsync(await CreateInviteAsync(owner, serverId), "bye" + Random.Shared.Next(1000, 9999))).EnsureSuccessStatusCode();
        var savedCookie = c.Handler.Cookies.GetCookieHeader(new Uri("http://localhost"));
        Assert.Equal(HttpStatusCode.NoContent, (await c.Http.PostAsync("/api/v1/auth/logout", null)).StatusCode);

        // Replaying the old cookie after logout must fail: the session row is revoked.
        using var replay = factory.CreateClient();
        replay.DefaultRequestHeaders.Add("Cookie", savedCookie);
        Assert.Equal(HttpStatusCode.Unauthorized, (await replay.GetAsync("/api/v1/auth/me")).StatusCode);
    }

    [Fact]
    public async Task Member_cannot_create_invitations()
    {
        var (owner, serverId) = await EnsureOwnerAsync();
        var m = factory.NewClient();
        (await m.RegisterAsync(await CreateInviteAsync(owner, serverId), "plain" + Random.Shared.Next(1000, 9999))).EnsureSuccessStatusCode();
        var r = await m.Http.PostAsJsonAsync($"/api/v1/servers/{serverId}/invitations", new { maxUses = 1 });
        Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
    }

    [Fact]
    public async Task Invite_preview_names_the_inviter_and_the_list_shows_who_joined()
    {
        var (owner, serverId) = await EnsureOwnerAsync();
        var created = await owner.Http.PostAsJsonAsync($"/api/v1/servers/{serverId}/invitations", new { maxUses = 1, note = "For Gal" });
        var c = await Json(created);
        var secret = c.GetProperty("secret").GetString()!;
        var id = c.GetProperty("invitation").GetProperty("id").GetString();

        var anon = factory.NewClient();
        await anon.CsrfAsync();
        var preview = await Json(await anon.Http.PostAsJsonAsync("/api/v1/auth/invitations/preview", new { secret }));
        Assert.True(preview.GetProperty("valid").GetBoolean());
        Assert.False(string.IsNullOrEmpty(preview.GetProperty("invitedBy").GetString()));
        Assert.True(preview.GetProperty("memberCount").GetInt32() >= 1);
        var bogus = await Json(await anon.Http.PostAsJsonAsync("/api/v1/auth/invitations/preview", new { secret = "nope" }));
        Assert.False(bogus.GetProperty("valid").GetBoolean());
        Assert.False(bogus.TryGetProperty("invitedBy", out var by) && by.ValueKind == JsonValueKind.String);

        var login = "gal" + Random.Shared.Next(1000, 9999);
        (await anon.RegisterAsync(secret, login, displayName: "Gal")).EnsureSuccessStatusCode();

        var list = await Json(await owner.Http.GetAsync($"/api/v1/servers/{serverId}/invitations"));
        var row = list.EnumerateArray().Single(i => i.GetProperty("id").GetString() == id);
        Assert.Equal("usedUp", row.GetProperty("state").GetString());
        Assert.False(string.IsNullOrEmpty(row.GetProperty("createdByName").GetString()));
        Assert.Equal("Gal", row.GetProperty("joined")[0].GetProperty("displayName").GetString());

        var me = await Json(await owner.Http.GetAsync("/api/v1/auth/me"));
        var members = await Json(await owner.Http.GetAsync($"/api/v1/servers/{serverId}/members"));
        var gal = members.EnumerateArray().Single(m => m.GetProperty("login").GetString() == login);
        Assert.Equal(me.GetProperty("user").GetProperty("id").GetString(), gal.GetProperty("invitedBy").GetString());
    }

    [Fact]
    public async Task Joining_by_invite_posts_a_join_message_friends_can_wave_at()
    {
        var (owner, serverId) = await EnsureOwnerAsync();
        var newcomer = factory.NewClient();
        (await newcomer.RegisterAsync(await CreateInviteAsync(owner, serverId), "wave" + Random.Shared.Next(1000, 9999), displayName: "Waver")).EnsureSuccessStatusCode();
        var newcomerId = (await Json(await newcomer.Http.GetAsync("/api/v1/auth/me"))).GetProperty("user").GetProperty("id").GetString();

        var detail = await Json(await owner.Http.GetAsync($"/api/v1/servers/{serverId}"));
        var firstText = detail.GetProperty("channels").EnumerateArray().First(c => c.GetProperty("type").GetString() == "text").GetProperty("id").GetString();
        var page = await Json(await owner.Http.GetAsync($"/api/v1/channels/{firstText}/messages?limit=20"));
        var join = page.GetProperty("messages").EnumerateArray()
            .Single(m => m.GetProperty("authorUserId").GetString() == newcomerId && m.GetProperty("kind").GetString() == "memberJoined");
        var id = join.GetProperty("id").GetString();

        var edit = await newcomer.Http.PatchAsJsonAsync($"/api/v1/messages/{id}", new { expectedVersion = 1, body = "hacked" });
        Assert.Equal(HttpStatusCode.BadRequest, edit.StatusCode);
        Assert.Equal("message.system", (await Json(edit)).GetProperty("code").GetString());
        var wave = await owner.Http.PutAsync($"/api/v1/messages/{id}/reactions/{Uri.EscapeDataString("👋")}", null);
        Assert.True(wave.IsSuccessStatusCode);
    }
}
