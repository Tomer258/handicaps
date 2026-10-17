using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;

namespace Hangar.Core.Media;

public sealed record LiveKitParticipant(string Identity, string? Name, string? Metadata, IReadOnlyList<LiveKitTrack> Tracks);

public sealed record LiveKitTrack(string Sid, string Source, bool Muted);

/// <summary>The RoomService operations the app needs. Faked in tests; contract-tested against the pinned server.</summary>
public interface ILiveKitRooms
{
    Task EnsureRoomAsync(string room, int maxParticipants, CancellationToken ct);
    /// <summary>Null when the room does not exist.</summary>
    Task<IReadOnlyList<LiveKitParticipant>?> ListParticipantsAsync(string room, CancellationToken ct);
    Task<IReadOnlyList<string>> ListRoomsAsync(CancellationToken ct);
    Task RemoveParticipantAsync(string room, string identity, CancellationToken ct);
    Task UpdatePublishSourcesAsync(string room, string identity, IReadOnlyList<string> sources, CancellationToken ct);
    Task MuteTrackAsync(string room, string identity, string trackSid, bool muted, CancellationToken ct);
}

public sealed class LiveKitUnavailableException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>Twirp JSON client for livekit.RoomService over the private network, authenticated by a short admin JWT.</summary>
public sealed class LiveKitRoomClient(HttpClient http, IOptions<LiveKitOptions> options, TimeProvider clock) : ILiveKitRooms
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public Task EnsureRoomAsync(string room, int maxParticipants, CancellationToken ct) =>
        // CreateRoom is idempotent for an existing room name.
        CallAsync("CreateRoom", room, new { name = room, empty_timeout = 300, departure_timeout = 20, max_participants = maxParticipants }, ct);

    public async Task<IReadOnlyList<LiveKitParticipant>?> ListParticipantsAsync(string room, CancellationToken ct)
    {
        try
        {
            using var doc = await CallAsync("ListParticipants", room, new { room }, ct);
            var list = new List<LiveKitParticipant>();
            if (doc.RootElement.TryGetProperty("participants", out var ps))
                foreach (var p in ps.EnumerateArray())
                {
                    var tracks = new List<LiveKitTrack>();
                    if (p.TryGetProperty("tracks", out var ts))
                        foreach (var t in ts.EnumerateArray())
                            tracks.Add(new LiveKitTrack(Str(t, "sid") ?? "", Str(t, "source") ?? "UNKNOWN", t.TryGetProperty("muted", out var m) && m.GetBoolean()));
                    list.Add(new LiveKitParticipant(Str(p, "identity") ?? "", Str(p, "name"), Str(p, "metadata"), tracks));
                }
            return list;
        }
        catch (LiveKitNotFound)
        {
            return null;
        }
    }

    public async Task<IReadOnlyList<string>> ListRoomsAsync(CancellationToken ct)
    {
        using var doc = await CallAsync("ListRooms", null, new { }, ct);
        return doc.RootElement.TryGetProperty("rooms", out var rooms)
            ? rooms.EnumerateArray().Select(r => Str(r, "name") ?? "").Where(n => n.Length > 0).ToList()
            : [];
    }

    public async Task RemoveParticipantAsync(string room, string identity, CancellationToken ct)
    {
        try
        {
            (await CallAsync("RemoveParticipant", room, new { room, identity }, ct)).Dispose();
        }
        catch (LiveKitNotFound)
        {
            // Already gone: removal is idempotent.
        }
    }

    public async Task UpdatePublishSourcesAsync(string room, string identity, IReadOnlyList<string> sources, CancellationToken ct)
    {
        var permission = new
        {
            can_subscribe = true,
            can_publish = sources.Count > 0,
            can_publish_data = false,
            can_publish_sources = sources.Select(SourceEnum).ToArray(),
            can_update_metadata = false,
        };
        try
        {
            (await CallAsync("UpdateParticipant", room, new { room, identity, permission }, ct)).Dispose();
        }
        catch (LiveKitNotFound)
        {
        }
    }

    public async Task MuteTrackAsync(string room, string identity, string trackSid, bool muted, CancellationToken ct)
    {
        try
        {
            (await CallAsync("MutePublishedTrack", room, new { room, identity, track_sid = trackSid, muted }, ct)).Dispose();
        }
        catch (LiveKitNotFound)
        {
        }
    }

    private async Task<JsonDocument> CallAsync(string method, string? room, object body, CancellationToken ct)
    {
        var o = options.Value;
        var grant = new VideoGrant { Room = room, RoomAdmin = room is not null, RoomCreate = method == "CreateRoom", RoomList = method == "ListRooms" };
        var jwt = LiveKitTokens.Create(o.ApiKey, o.ApiSecret, "hangar-api", TimeSpan.FromMinutes(1), clock.GetUtcNow(), grant);
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{o.ApiUrl.TrimEnd('/')}/twirp/livekit.RoomService/{method}")
        {
            Content = JsonContent.Create(body, options: Json),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", jwt);
        HttpResponseMessage res;
        try
        {
            res = await http.SendAsync(req, ct);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            throw new LiveKitUnavailableException($"LiveKit {method} failed: {e.Message}", e);
        }
        using (res)
        {
            var text = await res.Content.ReadAsStringAsync(ct);
            if (res.IsSuccessStatusCode) return JsonDocument.Parse(string.IsNullOrWhiteSpace(text) ? "{}" : text);
            if ((int)res.StatusCode == 404 || text.Contains("\"not_found\"")) throw new LiveKitNotFound();
            throw new LiveKitUnavailableException($"LiveKit {method} returned {(int)res.StatusCode}: {Truncate(text)}");
        }
    }

    private static string SourceEnum(string source) => source switch
    {
        "microphone" => "MICROPHONE",
        "camera" => "CAMERA",
        "screen_share" => "SCREEN_SHARE",
        "screen_share_audio" => "SCREEN_SHARE_AUDIO",
        _ => "UNKNOWN",
    };

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static string Truncate(string s) => s.Length > 300 ? s[..300] : s;

    private sealed class LiveKitNotFound : Exception;
}
