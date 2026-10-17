using System.Security.Cryptography;
using System.Text;

namespace Hangar.Core.Common;

public static class Secrets
{
    /// <summary>URL-safe random secret (e.g. invitation token). Shown once, stored only as a hash.</summary>
    public static string NewToken(int bytes = 24) =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(bytes)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static string Sha256Hex(string value) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    public static string Sha256Hex(ReadOnlySpan<byte> value) => Convert.ToHexStringLower(SHA256.HashData(value));
}
