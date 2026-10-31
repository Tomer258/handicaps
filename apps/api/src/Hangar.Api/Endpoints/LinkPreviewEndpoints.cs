using Hangar.Api.Infrastructure;
using Microsoft.Extensions.Options;

namespace Hangar.Api.Endpoints;

public static class LinkPreviewEndpoints
{
    public static void MapLinkPreviews(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/link-previews").WithTags("Link previews");

        // Any signed-in user: the URL is one they could open themselves; the fetcher only reaches public addresses.
        g.MapGet("", async (string url, LinkPreviewService svc, IOptions<LinkPreviewOptions> opt, HttpContext http, CancellationToken ct) =>
        {
            http.Response.Headers.CacheControl = "private, max-age=600";
            if (!opt.Value.Enabled) return Results.NoContent();
            var preview = await svc.GetAsync(url, ct);
            return preview is null ? Results.NoContent() : Results.Ok(preview);
        });

        g.MapGet("/image", async (string t, LinkPreviewService svc, HttpContext http, CancellationToken ct) =>
        {
            var image = await svc.GetImageAsync(t, ct);
            var h = http.Response.Headers;
            h.XContentTypeOptions = "nosniff";
            h.ContentSecurityPolicy = "default-src 'none'; sandbox";
            h["Cross-Origin-Resource-Policy"] = "same-origin";
            h.CacheControl = "private, max-age=86400";
            return Results.File(image.Bytes, image.Mime);
        });
    }
}
