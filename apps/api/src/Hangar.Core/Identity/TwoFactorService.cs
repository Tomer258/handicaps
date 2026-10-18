using System.Security.Cryptography;
using System.Text;
using Hangar.Core.Audit;
using Hangar.Core.Common;
using Hangar.Core.Persistence;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace Hangar.Core.Identity;

/// <summary>Encrypts small secrets at rest (Data Protection in the host).</summary>
public interface ISecretProtector
{
    string Protect(string plaintext);
    string Unprotect(string protectedText);
}

public sealed record TwoFactorStatus(bool Enabled, int RecoveryCodesLeft);
public sealed record TwoFactorSetup(string Secret, string OtpAuthUri);

/// <summary>
/// Two-step login with an authenticator app (RFC 6238 TOTP: SHA-1, 6 digits, 30 s, ±1 step) and ten single-use
/// recovery codes. Codes are never accepted twice (TotpLastStep), and failed attempts count toward the login throttle.
/// </summary>
public sealed class TwoFactorService(
    HangarDbContext db,
    IPasswordHasher<User> hasher,
    ISecretProtector protector,
    TimeProvider clock,
    AuditService audit,
    LoginThrottle throttle)
{
    private const string Issuer = "Hangar";
    private const int RecoveryCodeCount = 10;

    public async Task<TwoFactorStatus> StatusAsync(Guid userId, CancellationToken ct)
    {
        var u = await db.Users.AsNoTracking().FirstAsync(x => x.Id == userId, ct);
        return new TwoFactorStatus(u.TwoFactorEnabledAt is not null, u.RecoveryCodeHashes?.Length ?? 0);
    }

    /// <summary>Starts (or restarts) enrolment: a fresh secret that only becomes active after a code proves it works.</summary>
    public async Task<TwoFactorSetup> BeginSetupAsync(Guid userId, CancellationToken ct)
    {
        var u = await db.Users.FirstAsync(x => x.Id == userId, ct);
        if (u.TwoFactorEnabledAt is not null)
            throw AppProblem.Conflict("2fa.already_enabled", "Two-step login is already on.");
        var secret = Totp.Base32(RandomNumberGenerator.GetBytes(20));
        u.TotpSecret = protector.Protect(secret);
        await db.SaveChangesAsync(ct);
        var label = Uri.EscapeDataString($"{Issuer}:{u.Login}");
        return new TwoFactorSetup(secret, $"otpauth://totp/{label}?secret={secret}&issuer={Issuer}&algorithm=SHA1&digits=6&period=30");
    }

    /// <summary>Confirms enrolment with a current code; returns the recovery codes (shown once).</summary>
    public async Task<IReadOnlyList<string>> EnableAsync(Guid userId, string code, CancellationToken ct)
    {
        var u = await db.Users.FirstAsync(x => x.Id == userId, ct);
        if (u.TwoFactorEnabledAt is not null)
            throw AppProblem.Conflict("2fa.already_enabled", "Two-step login is already on.");
        if (u.TotpSecret is null)
            throw AppProblem.BadRequest("2fa.no_setup", "Start the setup again.");
        var step = Totp.Match(protector.Unprotect(u.TotpSecret), code, clock.GetUtcNow(), u.TotpLastStep)
                   ?? throw AppProblem.BadRequest("2fa.invalid_code", "That code didn't match. Check the time on your phone and try again.");
        var codes = NewRecoveryCodes();
        u.TotpLastStep = step;
        u.TwoFactorEnabledAt = clock.GetUtcNow();
        u.RecoveryCodeHashes = codes.Select(HashRecovery).ToArray();
        audit.Record(userId, "user", userId.ToString(), "auth.2fa_enable");
        await db.SaveChangesAsync(ct);
        return codes;
    }

    public async Task<IReadOnlyList<string>> RegenerateRecoveryCodesAsync(Guid userId, string password, CancellationToken ct)
    {
        var u = await RequirePasswordAsync(userId, password, ct);
        if (u.TwoFactorEnabledAt is null) throw AppProblem.BadRequest("2fa.not_enabled", "Two-step login is off.");
        var codes = NewRecoveryCodes();
        u.RecoveryCodeHashes = codes.Select(HashRecovery).ToArray();
        audit.Record(userId, "user", userId.ToString(), "auth.2fa_recovery_regenerate");
        await db.SaveChangesAsync(ct);
        return codes;
    }

    public async Task DisableAsync(Guid userId, string password, CancellationToken ct)
    {
        var u = await RequirePasswordAsync(userId, password, ct);
        u.TotpSecret = null;
        u.TwoFactorEnabledAt = null;
        u.TotpLastStep = null;
        u.RecoveryCodeHashes = null;
        audit.Record(userId, "user", userId.ToString(), "auth.2fa_disable");
        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Second login step: a 6-digit authenticator code or a recovery code (consumed). Throws the same error for every
    /// failure and records it against the account + IP throttle.
    /// </summary>
    public async Task VerifyLoginAsync(User u, string code, string clientIp, CancellationToken ct)
    {
        var key = "2fa:" + u.NormalizedLogin;
        throttle.EnsureAllowed(key, clientIp);
        var input = (code ?? "").Trim();
        var ok = false;
        if (u.TwoFactorEnabledAt is not null && u.TotpSecret is not null)
        {
            if (Totp.Match(protector.Unprotect(u.TotpSecret), input, clock.GetUtcNow(), u.TotpLastStep) is { } step)
            {
                // Compare-and-set: two requests racing with the same code cannot both pass.
                ok = await db.Users.Where(x => x.Id == u.Id && (x.TotpLastStep == null || x.TotpLastStep < step))
                    .ExecuteUpdateAsync(s => s.SetProperty(x => x.TotpLastStep, step), ct) == 1;
            }
            else if (u.RecoveryCodeHashes is { Length: > 0 } hashes && NormalizeRecovery(input) is { Length: 10 } rc)
            {
                var h = HashRecovery(rc);
                if (hashes.Contains(h))
                {
                    u.RecoveryCodeHashes = hashes.Where(x => x != h).ToArray();
                    audit.Record(u.Id, "user", u.Id.ToString(), "auth.2fa_recovery_used");
                    await db.SaveChangesAsync(ct);
                    ok = true;
                }
            }
        }
        if (!ok)
        {
            throttle.RecordFailure(key, clientIp);
            throw AppProblem.Unauthorized("auth.invalid_code", "That code didn't work.");
        }
        throttle.RecordSuccess(key, clientIp);
    }

    private async Task<User> RequirePasswordAsync(Guid userId, string password, CancellationToken ct)
    {
        var u = await db.Users.FirstAsync(x => x.Id == userId, ct);
        if (hasher.VerifyHashedPassword(u, u.PasswordHash, password ?? "") == PasswordVerificationResult.Failed)
            throw AppProblem.BadRequest("auth.invalid_password", "Current password is incorrect.");
        return u;
    }

    private static List<string> NewRecoveryCodes()
    {
        const string alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o/1/l/i
        return Enumerable.Range(0, RecoveryCodeCount).Select(_ =>
        {
            var c = RandomNumberGenerator.GetString(alphabet, 10);
            return $"{c[..5]}-{c[5..]}";
        }).ToList();
    }

    private static string NormalizeRecovery(string input) => new(input.ToLowerInvariant().Where(char.IsAsciiLetterOrDigit).ToArray());

    private static string HashRecovery(string code) =>
        Convert.ToHexString(SHA256.HashData(Encoding.ASCII.GetBytes(NormalizeRecovery(code))));
}

/// <summary>RFC 6238 / RFC 4226 primitives.</summary>
public static class Totp
{
    private const string Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    public static string Base32(byte[] data)
    {
        var sb = new StringBuilder();
        int buffer = 0, bits = 0;
        foreach (var b in data)
        {
            buffer = (buffer << 8) | b;
            bits += 8;
            while (bits >= 5)
            {
                sb.Append(Alphabet[(buffer >> (bits - 5)) & 31]);
                bits -= 5;
            }
        }
        if (bits > 0) sb.Append(Alphabet[(buffer << (5 - bits)) & 31]);
        return sb.ToString();
    }

    public static byte[] FromBase32(string s)
    {
        var bytes = new List<byte>();
        int buffer = 0, bits = 0;
        foreach (var ch in s.TrimEnd('=').ToUpperInvariant())
        {
            var v = Alphabet.IndexOf(ch);
            if (v < 0) throw new FormatException("Invalid base32.");
            buffer = (buffer << 5) | v;
            bits += 5;
            if (bits >= 8)
            {
                bytes.Add((byte)(buffer >> (bits - 8)));
                bits -= 8;
            }
        }
        return bytes.ToArray();
    }

    public static string Code(byte[] key, long step)
    {
        Span<byte> counter = stackalloc byte[8];
        System.Buffers.Binary.BinaryPrimitives.WriteInt64BigEndian(counter, step);
        var hash = HMACSHA1.HashData(key, counter);
        var offset = hash[^1] & 0x0f;
        var bin = ((hash[offset] & 0x7f) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
        return (bin % 1_000_000).ToString("D6");
    }

    public static long Step(DateTimeOffset at) => at.ToUnixTimeSeconds() / 30;

    /// <summary>The matching time step within ±1 of now that is newer than <paramref name="lastStep"/>, else null.</summary>
    public static long? Match(string base32Secret, string code, DateTimeOffset now, long? lastStep)
    {
        var digits = new string((code ?? "").Where(char.IsAsciiDigit).ToArray());
        if (digits.Length != 6 || (code ?? "").Trim().Length > 8) return null;
        var key = FromBase32(base32Secret);
        var current = Step(now);
        for (var s = current - 1; s <= current + 1; s++)
        {
            if (lastStep is not null && s <= lastStep) continue;
            if (CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(Code(key, s)), Encoding.ASCII.GetBytes(digits)))
                return s;
        }
        return null;
    }
}
