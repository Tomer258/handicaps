using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;
using Hangar.Core.Common;
using Microsoft.AspNetCore.DataProtection;

namespace Hangar.Api.Infrastructure;

/// <summary>Hangar:LinkPreviews.</summary>
public sealed class LinkPreviewOptions
{
    public bool Enabled { get; set; } = true;
    /// <summary>Tests only: lets the fetcher reach loopback/private addresses and any port.</summary>
    public bool AllowPrivateAddresses { get; set; }
}

/// <summary>
/// What a chat link shows under the message. <see cref="ImageUrl"/> is a signed same-origin proxy path: the browser never
/// contacts the linked site (no viewer IPs leak, the CSP keeps img-src 'self').
/// </summary>
public sealed record LinkPreviewDto(
    string Url, string Kind, string? SiteName, string? Title, string? Description, string? ImageUrl, string? ThemeColor, string? YoutubeId);

public sealed record PreviewImage(byte[] Bytes, string Mime);

/// <summary>
/// Fetches Open Graph / Twitter card metadata for http(s) links through <see cref="SafeHttp"/> and caches the result in
/// memory (6 h, failures 30 min, bounded). Concurrent requests for the same URL share one fetch.
/// </summary>
public sealed partial class LinkPreviewService(IHttpClientFactory http, IDataProtectionProvider protection, TimeProvider clock, ILogger<LinkPreviewService> log)
{
    public const string ClientName = "link-previews";
    private const int MaxHtmlBytes = 1024 * 1024;
    private const int MaxImageBytes = 5 * 1024 * 1024;
    private const int MaxEntries = 2000;
    private static readonly TimeSpan Fresh = TimeSpan.FromHours(6);
    private static readonly TimeSpan FailedFresh = TimeSpan.FromMinutes(30);

    private readonly ITimeLimitedDataProtector _images = protection.CreateProtector("Hangar.LinkPreviewImage.v1").ToTimeLimitedDataProtector();
    private readonly ConcurrentDictionary<string, (DateTimeOffset At, LinkPreviewDto? Preview)> _cache = new();
    private readonly ConcurrentDictionary<string, Lazy<Task<LinkPreviewDto?>>> _inflight = new();

    /// <summary>Null when the page has nothing worth showing (or could not be fetched).</summary>
    public async Task<LinkPreviewDto?> GetAsync(string rawUrl, CancellationToken ct)
    {
        var url = Normalize(rawUrl) ?? throw AppProblem.BadRequest("preview.url", "That is not a web link.");
        var now = clock.GetUtcNow();
        if (_cache.TryGetValue(url, out var hit) && now - hit.At < (hit.Preview is null ? FailedFresh : Fresh)) return hit.Preview;
        var lazy = _inflight.GetOrAdd(url, u => new Lazy<Task<LinkPreviewDto?>>(() => FetchAndCacheAsync(u)));
        return await lazy.Value.WaitAsync(ct);
    }

    /// <summary>The image behind a signed token from a preview, checked to really be a PNG/JPEG/GIF/WebP.</summary>
    public async Task<PreviewImage> GetImageAsync(string token, CancellationToken ct)
    {
        string url;
        try
        {
            url = _images.Unprotect(token);
        }
        catch (Exception)
        {
            throw AppProblem.NotFound("preview.image", "That image link expired.");
        }
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(10));
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.Accept.ParseAdd("image/webp,image/png,image/jpeg,image/gif;q=0.9");
            using var res = await http.CreateClient(ClientName).SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
            if (!res.IsSuccessStatusCode || res.Content.Headers.ContentLength > MaxImageBytes) throw AppProblem.NotFound("preview.image", "Image unavailable.");
            var bytes = await ReadCappedAsync(res, MaxImageBytes, cts.Token) ?? throw AppProblem.NotFound("preview.image", "Image too large.");
            var mime = SniffImage(bytes) ?? throw AppProblem.NotFound("preview.image", "Not an image.");
            return new PreviewImage(bytes, mime);
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException && !ct.IsCancellationRequested)
        {
            throw AppProblem.NotFound("preview.image", "Image unavailable.");
        }
    }

    private async Task<LinkPreviewDto?> FetchAndCacheAsync(string url)
    {
        await Task.Yield(); // the in-flight entry is always registered before this can remove it
        LinkPreviewDto? preview = null;
        try
        {
            preview = await FetchAsync(url);
        }
        catch (Exception e)
        {
            // Any failure (network, refused address, odd markup) is just "no preview"; it is retried after FailedFresh.
            log.LogDebug("Link preview for {Host} failed: {Error}", new Uri(url).Host, e.Message);
        }
        if (_cache.Count >= MaxEntries)
            foreach (var old in _cache.OrderBy(kv => kv.Value.At).Take(MaxEntries / 4).ToList()) _cache.TryRemove(old.Key, out _);
        _cache[url] = (clock.GetUtcNow(), preview);
        _inflight.TryRemove(url, out _);
        return preview;
    }

    private async Task<LinkPreviewDto?> FetchAsync(string url)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Accept.ParseAdd("text/html,application/xhtml+xml;q=0.9,image/*;q=0.8");
        req.Headers.AcceptLanguage.ParseAdd("en,he;q=0.8");
        using var res = await http.CreateClient(ClientName).SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        if (!res.IsSuccessStatusCode) return null;
        var final = res.RequestMessage?.RequestUri ?? new Uri(url);
        var type = res.Content.Headers.ContentType?.MediaType ?? "";
        if (type.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
            return new LinkPreviewDto(url, "image", null, null, null, ImageToken(final.AbsoluteUri), null, null);
        if (type is not ("text/html" or "application/xhtml+xml")) return null;

        var bytes = await ReadCappedAsync(res, MaxHtmlBytes, cts.Token, truncate: true) ?? [];
        var html = Decode(bytes, res.Content.Headers.ContentType);
        var meta = ParseMeta(html);
        string? Pick(params string[] keys) => keys.Select(k => meta.GetValueOrDefault(k)).FirstOrDefault(v => !string.IsNullOrWhiteSpace(v));

        var title = Clean(Pick("og:title", "twitter:title") ?? TitleTag(html), 256);
        var description = Clean(Pick("og:description", "twitter:description", "description"), 350);
        var site = Clean(Pick("og:site_name", "application-name"), 80) ?? final.Host.Replace("www.", "", StringComparison.OrdinalIgnoreCase);
        var image = Pick("og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src");
        string? imageUrl = null;
        if (image is not null && Uri.TryCreate(final, WebUtility.HtmlDecode(image.Trim()), out var abs) && abs.Scheme is "http" or "https")
            imageUrl = ImageToken(abs.AbsoluteUri);
        var color = Pick("theme-color");
        if (color is not null && !ColorRegex().IsMatch(color)) color = null;
        if (title is null && description is null && imageUrl is null) return null;
        return new LinkPreviewDto(url, "page", site, title, description, imageUrl, color, YoutubeId(final) ?? YoutubeId(new Uri(url)));
    }

    private string ImageToken(string absoluteUrl) =>
        "/api/v1/link-previews/image?t=" + Uri.EscapeDataString(_images.Protect(absoluteUrl, TimeSpan.FromDays(7)));

    /// <summary>http(s) only, no credentials, at most 2048 characters; fragment dropped.</summary>
    public static string? Normalize(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw) || raw.Length > 2048) return null;
        if (!Uri.TryCreate(raw.Trim(), UriKind.Absolute, out var u) || u.Scheme is not ("http" or "https") || !string.IsNullOrEmpty(u.UserInfo) || u.HostNameType == UriHostNameType.Unknown)
            return null;
        return new UriBuilder(u) { Fragment = "" }.Uri.AbsoluteUri;
    }

    /// <summary>youtube.com/watch?v=, youtu.be/, /shorts/, /embed/, /live/ → the 11-character video id.</summary>
    public static string? YoutubeId(Uri u)
    {
        var host = u.Host.ToLowerInvariant();
        string? id = null;
        if (host is "youtu.be") id = u.AbsolutePath.Trim('/').Split('/')[0];
        else if (host is "youtube.com" or "www.youtube.com" or "m.youtube.com" or "music.youtube.com")
        {
            var path = u.AbsolutePath;
            if (path == "/watch") id = System.Web.HttpUtility.ParseQueryString(u.Query)["v"];
            else if (YoutubePathRegex().Match(path) is { Success: true } m) id = m.Groups[1].Value;
        }
        return id is not null && YoutubeIdRegex().IsMatch(id) ? id : null;
    }

    public static Dictionary<string, string> ParseMeta(string html)
    {
        var head = html;
        var end = html.IndexOf("</head", StringComparison.OrdinalIgnoreCase);
        if (end > 0) head = html[..end];
        var meta = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match tag in MetaTagRegex().Matches(head))
        {
            string? key = null, content = null;
            foreach (Match a in AttrRegex().Matches(tag.Value))
            {
                var name = a.Groups[1].Value.ToLowerInvariant();
                var value = a.Groups[3].Success ? a.Groups[3].Value : a.Groups[4].Success ? a.Groups[4].Value : a.Groups[5].Value;
                if (name is "property" or "name" or "itemprop") key ??= value.Trim();
                else if (name == "content") content = value;
            }
            if (key is not null && content is not null) meta.TryAdd(key, content);
        }
        return meta;
    }

    private static string? TitleTag(string html) => TitleRegex().Match(html) is { Success: true } m ? m.Groups[1].Value : null;

    private static string? Clean(string? s, int max)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        s = SpaceRegex().Replace(WebUtility.HtmlDecode(s), " ").Trim();
        return s.Length == 0 ? null : s.Length <= max ? s : s[..(max - 1)].TrimEnd() + "…";
    }

    private static string Decode(byte[] bytes, MediaTypeHeaderValue? type)
    {
        Encoding enc = Encoding.UTF8;
        var charset = type?.CharSet ?? CharsetRegex().Match(Encoding.ASCII.GetString(bytes, 0, Math.Min(bytes.Length, 4096))).Groups[1].Value;
        if (!string.IsNullOrWhiteSpace(charset))
        {
            try { enc = Encoding.GetEncoding(charset.Trim('"', '\'')); } catch (ArgumentException) { /* keep UTF-8 */ }
        }
        return enc.GetString(bytes);
    }

    /// <summary>Reads at most <paramref name="max"/> bytes: null when larger (or the prefix when <paramref name="truncate"/>).</summary>
    private static async Task<byte[]?> ReadCappedAsync(HttpResponseMessage res, int max, CancellationToken ct, bool truncate = false)
    {
        await using var s = await res.Content.ReadAsStreamAsync(ct);
        using var ms = new MemoryStream();
        var buf = new byte[16 * 1024];
        int n;
        while ((n = await s.ReadAsync(buf, ct)) > 0)
        {
            if (ms.Length + n > max)
            {
                if (!truncate) return null;
                ms.Write(buf, 0, (int)(max - ms.Length));
                break;
            }
            ms.Write(buf, 0, n);
        }
        return ms.ToArray();
    }

    public static string? SniffImage(ReadOnlySpan<byte> b)
    {
        if (b.Length >= 8 && b[..8].SequenceEqual(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A })) return "image/png";
        if (b.Length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return "image/jpeg";
        if (b.Length >= 6 && (b[..6].SequenceEqual("GIF87a"u8) || b[..6].SequenceEqual("GIF89a"u8))) return "image/gif";
        if (b.Length >= 12 && b[..4].SequenceEqual("RIFF"u8) && b[8..12].SequenceEqual("WEBP"u8)) return "image/webp";
        return null;
    }

    [GeneratedRegex(@"<meta\b[^>]*>", RegexOptions.IgnoreCase)]
    private static partial Regex MetaTagRegex();
    [GeneratedRegex(@"([a-zA-Z:_-]+)\s*=\s*(""([^""]*)""|'([^']*)'|([^\s""'>]+))")]
    private static partial Regex AttrRegex();
    [GeneratedRegex(@"<title[^>]*>([^<]{1,512})</title>", RegexOptions.IgnoreCase)]
    private static partial Regex TitleRegex();
    [GeneratedRegex(@"<meta[^>]+charset\s*=\s*[""']?([A-Za-z0-9_-]+)", RegexOptions.IgnoreCase)]
    private static partial Regex CharsetRegex();
    [GeneratedRegex(@"\s+")]
    private static partial Regex SpaceRegex();
    [GeneratedRegex(@"^#[0-9a-fA-F]{3,8}$")]
    private static partial Regex ColorRegex();
    [GeneratedRegex(@"^/(?:shorts|embed|live)/([^/?#]+)")]
    private static partial Regex YoutubePathRegex();
    [GeneratedRegex(@"^[A-Za-z0-9_-]{11}$")]
    private static partial Regex YoutubeIdRegex();
}
