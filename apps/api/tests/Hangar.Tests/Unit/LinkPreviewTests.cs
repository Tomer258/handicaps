using System.Net;
using System.Net.Sockets;
using System.Text;
using Hangar.Api.Infrastructure;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Hangar.Tests.Unit;

public class LinkPreviewTests
{
    [Theory]
    [InlineData("127.0.0.1", false)]
    [InlineData("10.1.2.3", false)]
    [InlineData("172.20.0.5", false)]
    [InlineData("192.168.1.10", false)]
    [InlineData("169.254.169.254", false)] // cloud metadata
    [InlineData("100.64.0.1", false)]
    [InlineData("0.0.0.0", false)]
    [InlineData("224.0.0.1", false)]
    [InlineData("::1", false)]
    [InlineData("::ffff:127.0.0.1", false)]
    [InlineData("fe80::1", false)]
    [InlineData("fd00::1", false)]
    [InlineData("64:ff9b::7f00:1", false)] // NAT64 of 127.0.0.1
    [InlineData("2002:7f00:1::1", false)] // 6to4 of 127.0.0.1
    [InlineData("2001:db8::1", false)]
    [InlineData("8.8.8.8", true)]
    [InlineData("142.250.74.14", true)]
    [InlineData("2606:4700:4700::1111", true)]
    public void Only_public_unicast_addresses_are_reachable(string ip, bool expected) =>
        Assert.Equal(expected, SafeHttp.IsPublic(IPAddress.Parse(ip)));

    [Theory]
    [InlineData("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42", "dQw4w9WgXcQ")]
    [InlineData("https://youtu.be/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ")]
    [InlineData("https://youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ")]
    [InlineData("https://m.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ")]
    [InlineData("https://www.youtube.com/watch?v=bad", null)]
    [InlineData("https://example.com/watch?v=dQw4w9WgXcQ", null)]
    public void Youtube_ids_are_recognised(string url, string? id) => Assert.Equal(id, LinkPreviewService.YoutubeId(new Uri(url)));

    [Theory]
    [InlineData("javascript:alert(1)")]
    [InlineData("file:///etc/passwd")]
    [InlineData("https://user:pw@example.com/")]
    [InlineData("not a url")]
    public void Only_plain_web_links_are_accepted(string url) => Assert.Null(LinkPreviewService.Normalize(url));

    [Fact]
    public void Meta_tags_are_read_in_any_attribute_order_and_quoting()
    {
        var meta = LinkPreviewService.ParseMeta("""
            <html><head><title>Fallback</title>
            <meta content="Night raid" property="og:title">
            <meta property='og:description' content='Bring snacks &amp; a mic'>
            <meta name=theme-color content=#ff0066>
            </head><body><meta property="og:title" content="ignored body tag"></body></html>
            """);
        Assert.Equal("Night raid", meta["og:title"]);
        Assert.Equal("Bring snacks &amp; a mic", meta["og:description"]);
        Assert.Equal("#ff0066", meta["theme-color"]);
    }

    [Fact]
    public void Images_are_recognised_by_their_bytes_not_their_name()
    {
        Assert.Equal("image/png", LinkPreviewService.SniffImage(Png));
        Assert.Equal("image/gif", LinkPreviewService.SniffImage("GIF89a......"u8));
        Assert.Null(LinkPreviewService.SniffImage("<svg xmlns=\"http://www.w3.org/2000/svg\"/>"u8));
        Assert.Null(LinkPreviewService.SniffImage("<html>"u8));
    }

    [Fact]
    public async Task Pages_on_private_addresses_are_never_fetched()
    {
        await using var site = new TinySite();
        var svc = Service(allowPrivate: false);
        Assert.Null(await svc.GetAsync(site.Url("/page"), CancellationToken.None));
        Assert.Equal(0, site.Hits);
    }

    [Fact]
    public async Task A_page_becomes_a_card_with_a_proxied_image()
    {
        await using var site = new TinySite();
        var svc = Service(allowPrivate: true);
        var p = await svc.GetAsync(site.Url("/page#frag"), CancellationToken.None);
        Assert.NotNull(p);
        Assert.Equal("page", p.Kind);
        Assert.Equal("Raid night", p.Title);
        Assert.Equal("Snacks & mics", p.Description);
        Assert.Equal("Tiny Site", p.SiteName);
        Assert.StartsWith("/api/v1/link-previews/image?t=", p.ImageUrl);
        Assert.Equal(1, site.Hits);

        // Cached: a second viewer does not refetch.
        await svc.GetAsync(site.Url("/page"), CancellationToken.None);
        Assert.Equal(1, site.Hits);

        var token = Uri.UnescapeDataString(p.ImageUrl!.Split("t=")[1]);
        var img = await svc.GetImageAsync(token, CancellationToken.None);
        Assert.Equal("image/png", img.Mime);
        await Assert.ThrowsAsync<Hangar.Core.Common.AppProblem>(() => svc.GetImageAsync("forged", CancellationToken.None));
    }

    [Fact]
    public async Task Non_images_behind_an_image_link_are_refused()
    {
        await using var site = new TinySite();
        var svc = Service(allowPrivate: true);
        var p = await svc.GetAsync(site.Url("/fake-image"), CancellationToken.None);
        Assert.NotNull(p);
        Assert.Equal("image", p.Kind);
        var token = Uri.UnescapeDataString(p.ImageUrl!.Split("t=")[1]);
        await Assert.ThrowsAsync<Hangar.Core.Common.AppProblem>(() => svc.GetImageAsync(token, CancellationToken.None));
    }

    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];

    private static LinkPreviewService Service(bool allowPrivate) =>
        new(new Factory(allowPrivate), new EphemeralDataProtectionProvider(), TimeProvider.System, NullLogger<LinkPreviewService>.Instance);

    private sealed class Factory(bool allowPrivate) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(SafeHttp.CreateHandler(allowPrivate)) { Timeout = TimeSpan.FromSeconds(10) };
    }

    /// <summary>A loopback HTTP server: /page (Open Graph + relative image), /img.png, /fake-image (SVG labelled as PNG).</summary>
    private sealed class TinySite : IAsyncDisposable
    {
        private readonly HttpListener _listener = new();
        private readonly int _port;
        private int _hits;
        public int Hits => _hits;

        public TinySite()
        {
            var probe = new TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            _port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
            _listener.Prefixes.Add($"http://127.0.0.1:{_port}/");
            _listener.Start();
            _ = Task.Run(LoopAsync);
        }

        public string Url(string path) => $"http://127.0.0.1:{_port}{path}";

        private async Task LoopAsync()
        {
            while (_listener.IsListening)
            {
                HttpListenerContext ctx;
                try { ctx = await _listener.GetContextAsync(); } catch { return; }
                var path = ctx.Request.Url!.AbsolutePath;
                if (path == "/page") Interlocked.Increment(ref _hits);
                (string type, byte[] body) = path switch
                {
                    "/page" => ("text/html; charset=utf-8", Encoding.UTF8.GetBytes(
                        "<html><head><meta property=\"og:title\" content=\"Raid night\"><meta property=\"og:description\" content=\"Snacks &amp; mics\">" +
                        "<meta property=\"og:site_name\" content=\"Tiny Site\"><meta property=\"og:image\" content=\"/img.png\"></head><body>hi</body></html>")),
                    "/img.png" => ("image/png", Png),
                    "/fake-image" => ("image/png", Encoding.UTF8.GetBytes("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>")),
                    _ => ("text/plain", Encoding.UTF8.GetBytes("nope")),
                };
                ctx.Response.ContentType = type;
                await ctx.Response.OutputStream.WriteAsync(body);
                ctx.Response.Close();
            }
        }

        public ValueTask DisposeAsync()
        {
            _listener.Stop();
            _listener.Close();
            return ValueTask.CompletedTask;
        }
    }
}
