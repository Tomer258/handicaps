using System.Text.Json;
using Hangar.Core.Files;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Hangar.Tests.Integration;

/// <summary>
/// Plays the asset-validator container: for every queued job writes the output (sounds: the already-canonical input;
/// images: a WebP header with the given canvas size) plus a result descriptor, then runs the API's collector.
/// </summary>
public static class FakeValidator
{
    public static async Task RunAsync(ApiFactory factory, string? error = null, int width = 640, int height = 480)
    {
        var root = factory.Services.GetRequiredService<IOptions<StorageOptions>>().Value.Root;
        foreach (var path in Directory.GetFiles(Path.Combine(root, "spool", "jobs"), "*.json"))
        {
            var job = JsonDocument.Parse(await File.ReadAllTextAsync(path)).RootElement;
            var id = job.GetProperty("jobId").GetString()!;
            var output = Path.Combine(root, job.GetProperty("output").GetString()!);
            var image = job.TryGetProperty("type", out var t) && t.GetString() == FileService.ImageJob;
            if (error is null)
            {
                if (image) await File.WriteAllBytesAsync(output, WebpHeader(width, height));
                else File.Copy(Path.Combine(root, job.GetProperty("input").GetString()!), output, true);
            }
            File.Delete(path);
            await File.WriteAllTextAsync(Path.Combine(root, "spool", "results", $"{id}.json"),
                JsonSerializer.Serialize(new { jobId = id, ok = error is null, error, width, height }));
        }
        using var scope = factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<ValidationCollector>().CollectAsync(CancellationToken.None);
    }

    /// <summary>RIFF/WEBP with a VP8X chunk declaring the canvas size (enough for the API's container check).</summary>
    public static byte[] WebpHeader(int width, int height)
    {
        var b = new byte[64];
        "RIFF"u8.CopyTo(b);
        BitConverter.GetBytes(b.Length - 8).CopyTo(b, 4);
        "WEBPVP8X"u8.CopyTo(b.AsSpan(8));
        BitConverter.GetBytes(10).CopyTo(b, 16);
        void U24(int at, int v) { b[at] = (byte)v; b[at + 1] = (byte)(v >> 8); b[at + 2] = (byte)(v >> 16); }
        U24(24, width - 1);
        U24(27, height - 1);
        return b;
    }
}
