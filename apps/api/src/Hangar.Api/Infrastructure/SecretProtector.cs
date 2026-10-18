using Hangar.Core.Identity;
using Microsoft.AspNetCore.DataProtection;

namespace Hangar.Api.Infrastructure;

/// <summary>Secrets at rest (TOTP keys) under the persisted Data Protection key ring, which the backups carry.</summary>
public sealed class DataProtectionSecretProtector(IDataProtectionProvider provider) : ISecretProtector
{
    private readonly IDataProtector _p = provider.CreateProtector("Hangar.TotpSecret.v1");
    public string Protect(string plaintext) => _p.Protect(plaintext);
    public string Unprotect(string protectedText) => _p.Unprotect(protectedText);
}

/// <summary>
/// The token between the password step and the code step: user, security version and "remember me", valid for five
/// minutes. Stateless; a password change in between invalidates it through the security version.
/// </summary>
public sealed class LoginChallenges(IDataProtectionProvider provider)
{
    private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(5);
    private readonly ITimeLimitedDataProtector _p = provider.CreateProtector("Hangar.LoginChallenge.v1").ToTimeLimitedDataProtector();

    public string Issue(Guid userId, int securityVersion, bool remember) =>
        _p.Protect($"{userId:N}|{securityVersion}|{(remember ? 1 : 0)}", Lifetime);

    public (Guid UserId, int SecurityVersion, bool Remember)? Read(string? token)
    {
        try
        {
            var parts = _p.Unprotect(token ?? "").Split('|');
            return (Guid.Parse(parts[0]), int.Parse(parts[1]), parts[2] == "1");
        }
        catch (Exception e) when (e is System.Security.Cryptography.CryptographicException or FormatException or IndexOutOfRangeException)
        {
            return null;
        }
    }
}
