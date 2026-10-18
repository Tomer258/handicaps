using System.Net;
using System.Net.Http.Json;
using Hangar.Core.Identity;
using static Hangar.Tests.Integration.Scenario;

namespace Hangar.Tests.Integration;

/// <summary>Two-step login: enrolment, the code step, replay protection, recovery codes, invalidation, disabling.</summary>
[Collection("api")]
public class TwoFactorTests(ApiFactory factory)
{
    private const string Password = "correct horse battery";

    [Fact]
    public void Totp_matches_the_rfc_6238_test_vector()
    {
        var key = "12345678901234567890"u8.ToArray();
        Assert.Equal("287082", Totp.Code(key, 1));           // T = 59 s (RFC 6238 appendix B, 6 digits)
        Assert.Equal("081804", Totp.Code(key, 37037036));    // T = 1111111109 s
        Assert.Equal(key, Totp.FromBase32(Totp.Base32(key)));
        var secret = Totp.Base32(key);
        var now = DateTimeOffset.FromUnixTimeSeconds(59);
        Assert.Equal(1, Totp.Match(secret, "287 082", now, null));
        Assert.Null(Totp.Match(secret, "287082", now, lastStep: 1)); // already used
        Assert.Null(Totp.Match(secret, "28708", now, null));
    }

    private async Task<(TestClient Client, string Login)> NewUserAsync()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var login = $"tf{Guid.NewGuid():N}"[..16];
        var c = factory.NewClient();
        (await c.RegisterAsync(await InviteAsync(owner, serverId), login)).EnsureSuccessStatusCode();
        return (c, login);
    }

    private static async Task<(byte[] Key, List<string> RecoveryCodes)> EnableAsync(TestClient c)
    {
        var setup = await Json(await c.Http.PostAsync("/api/v1/auth/2fa/setup", null));
        var secret = setup.GetProperty("secret").GetString()!;
        Assert.StartsWith("otpauth://totp/Hangar%3A", setup.GetProperty("otpAuthUri").GetString());
        var key = Totp.FromBase32(secret);

        var bad = await c.Http.PostAsJsonAsync("/api/v1/auth/2fa/enable", new { code = "000000" == Totp.Code(key, Now()) ? "111111" : "000000" });
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        var ok = await c.Http.PostAsJsonAsync("/api/v1/auth/2fa/enable", new { code = Totp.Code(key, Now()) });
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        var codes = (await Json(ok)).GetProperty("recoveryCodes").EnumerateArray().Select(x => x.GetString()!).ToList();
        Assert.Equal(10, codes.Distinct().Count());
        return (key, codes);
    }

    private static long Now() => Totp.Step(DateTimeOffset.UtcNow);

    private async Task<(TestClient Client, string Challenge)> PasswordStepAsync(string login)
    {
        var c = factory.NewClient();
        var r = await c.LoginAsync(login, Password);
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var body = await Json(r);
        Assert.True(body.GetProperty("twoFactorRequired").GetBoolean());
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.Http.GetAsync("/api/v1/auth/me")).StatusCode); // no session yet
        return (c, body.GetProperty("challenge").GetString()!);
    }

    private static Task<HttpResponseMessage> CodeAsync(TestClient c, string challenge, string code) =>
        c.Http.PostAsJsonAsync("/api/v1/auth/login/code", new { challenge, code });

    [Fact]
    public async Task Login_needs_a_fresh_code_after_enabling_and_a_used_code_is_refused()
    {
        var (user, login) = await NewUserAsync();
        var (key, _) = await EnableAsync(user);
        var status = await Json(await user.Http.GetAsync("/api/v1/auth/2fa"));
        Assert.True(status.GetProperty("enabled").GetBoolean());
        Assert.Equal(10, status.GetProperty("recoveryCodesLeft").GetInt32());

        var (c, challenge) = await PasswordStepAsync(login);
        // The code used to enable is spent; so is anything older.
        Assert.Equal(HttpStatusCode.Unauthorized, (await CodeAsync(c, challenge, Totp.Code(key, Now() - 1))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await CodeAsync(c, "forged", Totp.Code(key, Now() + 1))).StatusCode);
        var ok = await CodeAsync(c, challenge, Totp.Code(key, Now() + 1)); // next step, within the ±1 window
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await c.Http.GetAsync("/api/v1/auth/me")).StatusCode);

        // Same code again on another login: replay refused.
        var (c2, challenge2) = await PasswordStepAsync(login);
        Assert.Equal(HttpStatusCode.Unauthorized, (await CodeAsync(c2, challenge2, Totp.Code(key, Now() + 1))).StatusCode);
    }

    [Fact]
    public async Task Recovery_codes_work_once_and_a_password_change_voids_pending_challenges()
    {
        var (user, login) = await NewUserAsync();
        var (_, codes) = await EnableAsync(user);

        var (c, challenge) = await PasswordStepAsync(login);
        Assert.Equal(HttpStatusCode.OK, (await CodeAsync(c, challenge, codes[0].ToUpperInvariant().Replace("-", " "))).StatusCode);
        var (c2, challenge2) = await PasswordStepAsync(login);
        Assert.Equal(HttpStatusCode.Unauthorized, (await CodeAsync(c2, challenge2, codes[0])).StatusCode);
        Assert.Equal(9, (await Json(await user.Http.GetAsync("/api/v1/auth/2fa"))).GetProperty("recoveryCodesLeft").GetInt32());

        var (c3, pending) = await PasswordStepAsync(login);
        (await user.Http.PostAsJsonAsync("/api/v1/auth/password", new { currentPassword = Password, newPassword = Password + "!" })).EnsureSuccessStatusCode();
        var stale = await CodeAsync(c3, pending, codes[1]);
        Assert.Equal(HttpStatusCode.Unauthorized, stale.StatusCode);
        Assert.Equal("auth.challenge_expired", (await Json(stale)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task Disabling_needs_the_password_and_restores_one_step_login()
    {
        var (user, login) = await NewUserAsync();
        await EnableAsync(user);
        Assert.Equal(HttpStatusCode.BadRequest, (await user.Http.PostAsJsonAsync("/api/v1/auth/2fa/disable", new { password = "wrong password!!" })).StatusCode);
        var regen = await user.Http.PostAsJsonAsync("/api/v1/auth/2fa/recovery-codes", new { password = Password });
        Assert.Equal(10, (await Json(regen)).GetProperty("recoveryCodes").GetArrayLength());
        Assert.Equal(HttpStatusCode.NoContent, (await user.Http.PostAsJsonAsync("/api/v1/auth/2fa/disable", new { password = Password })).StatusCode);

        var c = factory.NewClient();
        var r = await c.LoginAsync(login, Password);
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.False((await Json(r)).TryGetProperty("twoFactorRequired", out _));
        Assert.Equal(HttpStatusCode.OK, (await c.Http.GetAsync("/api/v1/auth/me")).StatusCode);
    }
}
