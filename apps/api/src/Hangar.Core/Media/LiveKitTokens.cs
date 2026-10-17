using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Hangar.Core.Media;

/// <summary>Video grant subset we issue. Anything not listed (recording, metadata, data channel) is never granted.</summary>
public sealed record VideoGrant
{
    public string? Room { get; init; }
    public bool RoomJoin { get; init; }
    public bool RoomCreate { get; init; }
    public bool RoomList { get; init; }
    public bool RoomAdmin { get; init; }
    public bool CanPublish { get; init; }
    public bool CanSubscribe { get; init; }
    public bool CanPublishData { get; init; }
    public IReadOnlyList<string>? CanPublishSources { get; init; }
    public bool CanUpdateOwnMetadata { get; init; }
}

public sealed record VerifiedToken(string Issuer, string Identity, DateTimeOffset ExpiresAt, JsonObject Claims)
{
    public JsonObject? Video => Claims["video"] as JsonObject;
}

/// <summary>
/// Minimal HS256 JWT minting/verification in LiveKit's claim format (iss = API key, sub = identity, video grant).
/// Kept in-house to avoid a Node/Go dependency just for signing; covered by contract tests.
/// </summary>
public static class LiveKitTokens
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull };

    public static string Create(string apiKey, string apiSecret, string identity, TimeSpan lifetime, DateTimeOffset now,
        VideoGrant? video = null, string? name = null, string? metadata = null, IDictionary<string, object>? extra = null)
    {
        var payload = new JsonObject
        {
            ["iss"] = apiKey,
            ["sub"] = identity,
            ["nbf"] = now.AddSeconds(-5).ToUnixTimeSeconds(),
            ["exp"] = now.Add(lifetime).ToUnixTimeSeconds(),
            ["jti"] = Guid.NewGuid().ToString("N"),
        };
        if (name is not null) payload["name"] = name;
        if (metadata is not null) payload["metadata"] = metadata;
        if (video is not null) payload["video"] = JsonSerializer.SerializeToNode(video, Json);
        if (extra is not null)
            foreach (var (k, v) in extra) payload[k] = JsonSerializer.SerializeToNode(v, Json);
        return Sign(payload, apiSecret);
    }

    /// <summary>Verifies signature, algorithm, issuer and time window. Returns null for any defect (no partial trust).</summary>
    public static VerifiedToken? Verify(string token, string expectedIssuer, string apiSecret, DateTimeOffset now)
    {
        var parts = token.Split('.');
        if (parts.Length != 3 || token.Length > 8192) return null;
        try
        {
            var header = JsonNode.Parse(B64Decode(parts[0])) as JsonObject;
            if (header?["alg"]?.GetValue<string>() != "HS256") return null;
            var expected = Hmac(apiSecret, $"{parts[0]}.{parts[1]}");
            if (!CryptographicOperations.FixedTimeEquals(expected, B64Decode(parts[2]))) return null;
            if (JsonNode.Parse(B64Decode(parts[1])) is not JsonObject claims) return null;
            if (claims["iss"]?.GetValue<string>() != expectedIssuer) return null;
            var exp = claims["exp"]?.GetValue<long>() ?? 0;
            var nbf = claims["nbf"]?.GetValue<long>() ?? 0;
            var nowS = now.ToUnixTimeSeconds();
            if (exp < nowS - 10 || nbf > nowS + 10) return null;
            return new VerifiedToken(expectedIssuer, claims["sub"]?.GetValue<string>() ?? "", DateTimeOffset.FromUnixTimeSeconds(exp), claims);
        }
        catch (Exception e) when (e is JsonException or FormatException or InvalidOperationException)
        {
            return null;
        }
    }

    public static string Sha256Base64(byte[] body) => Convert.ToBase64String(SHA256.HashData(body));

    private static string Sign(JsonObject payload, string secret)
    {
        var header = B64Encode(Encoding.UTF8.GetBytes("""{"alg":"HS256","typ":"JWT"}"""));
        var body = B64Encode(Encoding.UTF8.GetBytes(payload.ToJsonString()));
        return $"{header}.{body}.{B64Encode(Hmac(secret, $"{header}.{body}"))}";
    }

    private static byte[] Hmac(string secret, string data) =>
        HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(data));

    private static string B64Encode(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] B64Decode(string s)
    {
        s = s.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(s.PadRight(s.Length + (4 - s.Length % 4) % 4, '='));
    }
}
