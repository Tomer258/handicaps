using System.Security.Cryptography;
using System.Text;
using Hangar.Api.Infrastructure;
using Hangar.Core.Common;
using Hangar.Core.Soundboard;
using Microsoft.Extensions.Options;

namespace Hangar.Api.Endpoints;

public static class SoundboardEndpoints
{
    public static void MapSoundboard(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("").WithTags("Soundboard");

        g.MapGet("/servers/{serverId:guid}/sounds", async (Guid serverId, HttpContext http, SoundboardService svc, CancellationToken ct) =>
            Results.Ok(await svc.CatalogAsync(http.User.UserId(), serverId, ct)));

        // Multipart: name, emoji?, trimStart?, trimEnd?, file. Read manually (no form binding) with a hard byte cap.
        g.MapPost("/servers/{serverId:guid}/sounds", async (Guid serverId, HttpContext http, SoundboardService svc,
            IOptions<SoundboardOptions> opt, CancellationToken ct) =>
        {
            if (!http.Request.HasFormContentType) throw AppProblem.BadRequest("sound.form", "Expected multipart/form-data.");
            if (http.Request.ContentLength > opt.Value.MaxUploadBytes + 64 * 1024)
                throw AppProblem.TooLarge("file.too_large", $"File is larger than {opt.Value.MaxUploadBytes / (1024 * 1024)} MB.");
            var form = await http.Request.ReadFormAsync(new Microsoft.AspNetCore.Http.Features.FormOptions
            {
                MultipartBodyLengthLimit = opt.Value.MaxUploadBytes + 64 * 1024,
                ValueCountLimit = 8,
                ValueLengthLimit = 256,
            }, ct);
            var file = form.Files.GetFile("file") ?? throw AppProblem.BadRequest("sound.file", "Choose an audio file.");
            await using var stream = file.OpenReadStream();
            var dto = await svc.UploadAsync(http.User.UserId(), serverId, form["name"], form["emoji"],
                ParseSeconds(form["trimStart"]), ParseSeconds(form["trimEnd"]), file.FileName, stream, ct);
            return Results.Created($"/api/v1/sounds/{dto.Id}", dto);
        });

        g.MapPatch("/sounds/{soundId:guid}", async (Guid soundId, SoundUpdateRequest req, HttpContext http, SoundboardService svc, CancellationToken ct) =>
            Results.Ok(await svc.UpdateAsync(http.User.UserId(), soundId, req, ct)));
        g.MapDelete("/sounds/{soundId:guid}", async (Guid soundId, HttpContext http, SoundboardService svc, CancellationToken ct) =>
        {
            await svc.DeleteAsync(http.User.UserId(), soundId, ct);
            return Results.NoContent();
        });
        g.MapPut("/sounds/{soundId:guid}/favorite", async (Guid soundId, HttpContext http, SoundboardService svc, CancellationToken ct) =>
        {
            await svc.SetFavoriteAsync(http.User.UserId(), soundId, true, ct);
            return Results.NoContent();
        });
        g.MapDelete("/sounds/{soundId:guid}/favorite", async (Guid soundId, HttpContext http, SoundboardService svc, CancellationToken ct) =>
        {
            await svc.SetFavoriteAsync(http.User.UserId(), soundId, false, ct);
            return Results.NoContent();
        });
        g.MapGet("/sounds/{soundId:guid}/preview", async (Guid soundId, HttpContext http, SoundboardService svc, CancellationToken ct) =>
        {
            var path = await svc.PreviewPathAsync(http.User.UserId(), soundId, ct);
            http.Response.Headers.CacheControl = "private, max-age=3600";
            http.Response.Headers["X-Content-Type-Options"] = "nosniff";
            return Results.File(path, "audio/wav", enableRangeProcessing: true);
        });

        g.MapPost("/channels/{channelId:guid}/sound-plays", async (Guid channelId, SoundPlayRequest req, HttpContext http, SoundPlaybackService svc, CancellationToken ct) =>
            Results.Ok(await svc.PlayAsync(http.User.UserId(), http.User.SessionId(), channelId, req, ct)));
        g.MapGet("/channels/{channelId:guid}/sound-plays", async (Guid channelId, HttpContext http, SoundPlaybackService svc, CancellationToken ct) =>
            Results.Ok(await svc.ActiveAsync(http.User.UserId(), channelId, ct)));
        g.MapDelete("/sound-plays/{playbackId:guid}", async (Guid playbackId, HttpContext http, SoundPlaybackService svc, CancellationToken ct) =>
        {
            await svc.StopAsync(http.User.UserId(), playbackId, ct);
            return Results.NoContent();
        });
        g.MapPost("/channels/{channelId:guid}/sound-stop-all", async (Guid channelId, HttpContext http, SoundPlaybackService svc, CancellationToken ct) =>
            Results.Ok(new { stopped = await svc.StopAllAsync(http.User.UserId(), channelId, ct) }));
    }

    /// <summary>Publisher worker callbacks (private network, shared key). Never exposed by the edge.</summary>
    public static void MapSoundboardInternal(this WebApplication app)
    {
        app.MapPost("/internal/soundboard/events", async (WorkerEvent ev, HttpContext http, SoundPlaybackService svc,
            IOptions<SoundboardOptions> opt, CancellationToken ct) =>
        {
            if (!WorkerKeyValid(http.Request.Headers["X-Hangar-Worker-Key"].ToString(), opt.Value.WorkerKey)) return Results.Unauthorized();
            await svc.HandleWorkerEventAsync(ev, ct);
            return Results.Ok();
        }).AllowAnonymous().ExcludeFromDescription();
    }

    private static bool WorkerKeyValid(string presented, string expected) =>
        expected.Length >= 16 && CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(presented), Encoding.UTF8.GetBytes(expected));

    private static double? ParseSeconds(string? value) =>
        double.TryParse(value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var v) && double.IsFinite(v)
            ? Math.Round(v, 3) : null;
}
