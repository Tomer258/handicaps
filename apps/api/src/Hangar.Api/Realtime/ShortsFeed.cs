using System.Net;
using System.Text.Json;
using Hangar.Core.Common;
using Microsoft.Extensions.Options;

namespace Hangar.Api.Realtime;

/// <summary>Hangar:YouTube. Without an API key the Shorts feed is off (the button explains how to turn it on).</summary>
public sealed class YouTubeOptions
{
    /// <summary>YouTube Data API v3 key (Google Cloud console). Free quota: 10,000 units a day; one search costs 100.</summary>
    public string? ApiKey { get; set; }
    /// <summary>ISO 3166-1 alpha-2 country whose popular Shorts to prefer (e.g. IL), optional.</summary>
    public string? Region { get; set; }
    /// <summary>ISO 639-1 language to prefer (e.g. he, en), optional.</summary>
    public string? Language { get; set; }
    public string BaseUrl { get; set; } = "https://www.googleapis.com/youtube/v3/";
}

/// <summary>Random Shorts for the watch-together feed.</summary>
public interface IShortsSource
{
    /// <summary><paramref name="count"/> Shorts not in <paramref name="exclude"/>; throws 503 problems when YouTube cannot be used.</summary>
    Task<IReadOnlyList<WatchItem>> NextAsync(int count, IReadOnlySet<string> exclude, CancellationToken ct);
}

/// <summary>
/// YouTube has no API for its Shorts feed, so this searches for popular recent Shorts (videoDuration=short, "#shorts")
/// on a random topic and in a random recent time window, and serves them shuffled from an in-memory pool. A search
/// returns up to 50 and costs 100 of the 10,000 free daily units, so a group scrolling all evening uses a few hundred.
/// Recently served ids are skipped so the feed does not repeat itself.
/// </summary>
public sealed class YouTubeShortsSource(IHttpClientFactory http, IOptions<YouTubeOptions> options, TimeProvider clock, ILogger<YouTubeShortsSource> log)
    : IShortsSource
{
    public const string ClientName = "youtube";
    private const int RecentLimit = 600;

    private static readonly string[] Topics =
    [
        "funny", "gaming", "cs2", "fails", "memes", "animals", "football", "basketball", "skate", "cooking", "street food",
        "magic trick", "satisfying", "dance", "music", "standup comedy", "pranks", "cars", "science", "life hacks",
        "minecraft", "fortnite", "valorant", "gym", "travel", "cats", "dogs", "art", "parkour", "movie scenes",
    ];

    private readonly Lock _gate = new();
    private readonly List<WatchItem> _pool = [];
    private readonly Queue<string> _recentOrder = new();
    private readonly HashSet<string> _recent = [];
    private readonly SemaphoreSlim _refill = new(1, 1);

    public async Task<IReadOnlyList<WatchItem>> NextAsync(int count, IReadOnlySet<string> exclude, CancellationToken ct)
    {
        var o = options.Value;
        if (string.IsNullOrWhiteSpace(o.ApiKey))
            throw new AppProblem(503, "shorts.not_configured", "The Shorts feed needs a YouTube API key. Ask the server owner to add one (Hangar__YouTube__ApiKey).");

        var picked = new List<WatchItem>();
        for (var attempt = 0; attempt < 3 && picked.Count < count; attempt++)
        {
            lock (_gate) Take(picked, count, exclude);
            if (picked.Count < count) await RefillAsync(o, ct);
        }
        lock (_gate) Take(picked, count, exclude);
        if (picked.Count == 0) throw new AppProblem(503, "shorts.empty", "YouTube didn't return any Shorts just now. Try again in a moment.");
        return picked;
    }

    private void Take(List<WatchItem> picked, int count, IReadOnlySet<string> exclude)
    {
        for (var i = _pool.Count - 1; i >= 0 && picked.Count < count; i--)
        {
            var item = _pool[i];
            _pool.RemoveAt(i);
            if (exclude.Contains(item.VideoId) || _recent.Contains(item.VideoId) || picked.Any(p => p.VideoId == item.VideoId)) continue;
            picked.Add(item);
            _recent.Add(item.VideoId);
            _recentOrder.Enqueue(item.VideoId);
            while (_recentOrder.Count > RecentLimit) _recent.Remove(_recentOrder.Dequeue());
        }
    }

    private async Task RefillAsync(YouTubeOptions o, CancellationToken ct)
    {
        await _refill.WaitAsync(ct);
        try
        {
            lock (_gate)
                if (_pool.Count >= 10) return; // another request refilled meanwhile

            var topic = Topics[Random.Shared.Next(Topics.Length)];
            var daysBack = Random.Shared.Next(2, 60);
            var after = clock.GetUtcNow().AddDays(-daysBack).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'");
            var query = new Dictionary<string, string?>
            {
                ["part"] = "snippet", ["type"] = "video", ["videoDuration"] = "short", ["videoEmbeddable"] = "true",
                ["maxResults"] = "50", ["order"] = Random.Shared.Next(3) == 0 ? "relevance" : "viewCount", ["safeSearch"] = "moderate",
                ["q"] = $"{topic} #shorts", ["publishedAfter"] = after, ["regionCode"] = o.Region, ["relevanceLanguage"] = o.Language, ["key"] = o.ApiKey,
            };
            var url = o.BaseUrl + "search?" + string.Join('&', query.Where(kv => !string.IsNullOrWhiteSpace(kv.Value))
                .Select(kv => $"{kv.Key}={Uri.EscapeDataString(kv.Value!)}"));

            using var res = await http.CreateClient(ClientName).GetAsync(url, ct);
            if (res.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.TooManyRequests)
            {
                var body = await res.Content.ReadAsStringAsync(ct);
                log.LogWarning("YouTube search refused ({Status}): {Body}", (int)res.StatusCode, body.Length > 300 ? body[..300] : body);
                throw body.Contains("quota", StringComparison.OrdinalIgnoreCase)
                    ? new AppProblem(503, "shorts.quota", "YouTube's daily limit for the Shorts feed is used up. It resets at midnight Pacific time.")
                    : new AppProblem(503, "shorts.key_rejected", "YouTube refused the server's API key. Check that the YouTube Data API v3 is enabled for it.");
            }
            if (!res.IsSuccessStatusCode)
            {
                log.LogWarning("YouTube search failed with {Status}", (int)res.StatusCode);
                throw new AppProblem(503, "shorts.unavailable", "YouTube didn't answer. Try again in a moment.");
            }

            using var doc = await JsonDocument.ParseAsync(await res.Content.ReadAsStreamAsync(ct), cancellationToken: ct);
            var found = new List<WatchItem>();
            if (doc.RootElement.TryGetProperty("items", out var items))
                foreach (var it in items.EnumerateArray())
                {
                    var id = it.TryGetProperty("id", out var idEl) && idEl.TryGetProperty("videoId", out var v) ? v.GetString() : null;
                    if (id is null || id.Length != 11) continue;
                    var title = it.TryGetProperty("snippet", out var sn) && sn.TryGetProperty("title", out var t) ? WebUtility.HtmlDecode(t.GetString()) : null;
                    found.Add(new WatchItem(id, title, true));
                }
            Random.Shared.Shuffle(System.Runtime.InteropServices.CollectionsMarshal.AsSpan(found));
            lock (_gate) _pool.InsertRange(0, found); // Take() serves from the end: older pool items go first
            log.LogInformation("Shorts pool +{Count} ({Topic}, last {Days} days)", found.Count, topic, daysBack);
        }
        catch (HttpRequestException e)
        {
            log.LogWarning(e, "YouTube search failed");
            throw new AppProblem(503, "shorts.unavailable", "YouTube didn't answer. Try again in a moment.");
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new AppProblem(503, "shorts.unavailable", "YouTube didn't answer in time. Try again in a moment.");
        }
        finally
        {
            _refill.Release();
        }
    }
}
