using Hangar.Api.Infrastructure;
using Hangar.Core.Common;
using Hangar.Core.Files;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Options;
using Microsoft.Net.Http.Headers;

namespace Hangar.Api.Endpoints;

public static class FileEndpoints
{
    public static void MapFiles(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("").WithTags("Files");

        g.MapPost("/servers/{serverId:guid}/attachments", async (Guid serverId, HttpContext http, FileService svc, IOptions<AttachmentOptions> opt, CancellationToken ct) =>
        {
            var file = await ReadSingleFileAsync(http, Math.Max(opt.Value.MaxImageBytes, opt.Value.MaxTextBytes), ct);
            await using var stream = file.OpenReadStream();
            var dto = await svc.UploadAttachmentAsync(http.User.UserId(), serverId, file.FileName, stream, ct);
            return Results.Created($"/api/v1/files/{dto.Id}/status", dto);
        });

        g.MapGet("/files/{id:guid}/status", async (Guid id, HttpContext http, FileService svc, CancellationToken ct) =>
            Results.Ok(await svc.StatusAsync(http.User.UserId(), id, ct)));

        g.MapGet("/attachments/{id:guid}", async (Guid id, bool? download, HttpContext http, FileService svc, CancellationToken ct) =>
            Serve(http, await svc.ReadAttachmentAsync(http.User.UserId(), id, ct), download == true));

        g.MapPost("/users/me/avatar", async (HttpContext http, FileService svc, IOptions<AttachmentOptions> opt, CancellationToken ct) =>
        {
            var file = await ReadSingleFileAsync(http, opt.Value.MaxAvatarBytes, ct);
            await using var stream = file.OpenReadStream();
            var dto = await svc.UploadAvatarAsync(http.User.UserId(), file.FileName, stream, ct);
            return Results.Accepted($"/api/v1/files/{dto.Id}/status", dto);
        });

        g.MapDelete("/users/me/avatar", async (HttpContext http, FileService svc, CancellationToken ct) =>
        {
            await svc.RemoveAvatarAsync(http.User.UserId(), ct);
            return Results.NoContent();
        });

        g.MapGet("/avatars/{id:guid}", async (Guid id, HttpContext http, FileService svc, CancellationToken ct) =>
        {
            var content = await svc.ReadAvatarAsync(http.User.UserId(), id, ct);
            // Avatar asset ids are immutable (a new upload gets a new id).
            http.Response.Headers.CacheControl = "private, max-age=604800, immutable";
            return Serve(http, content, false, setCache: false);
        });
    }

    private static async Task<IFormFile> ReadSingleFileAsync(HttpContext http, long maxBytes, CancellationToken ct)
    {
        if (!http.Request.HasFormContentType) throw AppProblem.BadRequest("file.form", "Expected multipart/form-data.");
        if (http.Request.ContentLength > maxBytes + 64 * 1024)
            throw AppProblem.TooLarge("file.too_large", $"File is larger than {maxBytes / (1024 * 1024)} MB.");
        var form = await http.Request.ReadFormAsync(new FormOptions
        {
            MultipartBodyLengthLimit = maxBytes + 64 * 1024,
            ValueCountLimit = 4,
            ValueLengthLimit = 256,
        }, ct);
        return form.Files.GetFile("file") ?? throw AppProblem.BadRequest("file.missing", "Choose a file.");
    }

    /// <summary>
    /// Serves stored bytes with defensive headers: nosniff, a sandboxing CSP and attachment disposition for anything
    /// that is not a validator-normalized image.
    /// </summary>
    private static IResult Serve(HttpContext http, FileContent content, bool forceDownload, bool setCache = true)
    {
        var h = http.Response.Headers;
        h.XContentTypeOptions = "nosniff";
        h.ContentSecurityPolicy = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";
        h["Cross-Origin-Resource-Policy"] = "same-origin";
        if (setCache) h.CacheControl = "private, max-age=3600";
        var inline = content.Inline && !forceDownload;
        var disposition = new ContentDispositionHeaderValue(inline ? "inline" : "attachment");
        disposition.SetHttpFileName(content.DownloadName);
        h.ContentDisposition = disposition.ToString();
        var mime = content.Mime == "text/plain" ? "text/plain; charset=utf-8" : content.Mime;
        return Results.File(content.Path, mime, enableRangeProcessing: true);
    }
}
