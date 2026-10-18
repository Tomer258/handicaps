using System.Text.Json;
using Hangar.Core.Persistence;
using Hangar.Core.Soundboard;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Hangar.Core.Files;

/// <summary>
/// Single reader of the validator's result spool. Each result is matched to its job (by the server-chosen job id only)
/// and dispatched by job type; jobs past their lease fail closed.
/// </summary>
public sealed class ValidationCollector(
    HangarDbContext db,
    LocalFileStore files,
    SoundboardService sounds,
    FileService images,
    TimeProvider clock,
    ILogger<ValidationCollector> log)
{
    public async Task CollectAsync(CancellationToken ct)
    {
        foreach (var name in files.ListJson($"{StorageArea.Spool}/results").ToList())
        {
            var path = files.SpoolPath($"{StorageArea.Spool}/results", name);
            ValidationResult? result = null;
            try
            {
                result = JsonSerializer.Deserialize<ValidationResult>(await File.ReadAllTextAsync(path, ct), JsonSerializerOptions.Web);
            }
            catch (Exception e) when (e is JsonException or IOException)
            {
                log.LogWarning(e, "Unreadable validation result {Name}", name);
            }
            if (result is not null && Guid.TryParseExact(result.JobId, "N", out var jobId) && name == $"{jobId:N}.json")
            {
                var job = await db.AssetValidationJobs.FirstOrDefaultAsync(j => j.Id == jobId, ct);
                if (job is { State: ValidationJobState.Queued or ValidationJobState.Processing })
                {
                    if (job.JobType == FileService.ImageJob) await images.ApplyImageResultAsync(job, result, ct);
                    else await sounds.ApplyResultAsync(job, result, ct);
                }
            }
            File.Delete(path);
        }

        var now = clock.GetUtcNow();
        var stale = await db.AssetValidationJobs
            .Where(j => (j.State == ValidationJobState.Queued || j.State == ValidationJobState.Processing) && j.LeaseExpiresAt < now)
            .ToListAsync(ct);
        foreach (var job in stale)
        {
            if (job.JobType == FileService.ImageJob) await images.FailImageAsync(job, "validator_timeout", ct);
            else await sounds.FailAsync(job, "validator_timeout", ct);
        }
    }
}
