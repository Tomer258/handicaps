using System.Security.Cryptography;
using System.Text.Json;
using Hangar.Core.Common;
using Microsoft.Extensions.Options;

namespace Hangar.Core.Files;

public sealed class StorageOptions
{
    /// <summary>Private storage root shared (by bind mount) with the validator and publisher containers.</summary>
    public string Root { get; set; } = "data/files";
}

/// <summary>Storage areas. Each worker mounts only what it needs (validator: quarantine ro, spool/sounds/images rw; publisher: sounds ro).</summary>
public static class StorageArea
{
    public const string Quarantine = "quarantine";
    public const string Spool = "spool";
    public const string Sounds = "sounds";
    public const string Attachments = "attachments";
    /// <summary>Validator-normalized raster images (attachments and avatars).</summary>
    public const string Images = "images";
}

/// <summary>
/// Private local file storage (ADR 010). Keys are random and never derived from client input; callers pass an area
/// constant and a key, never a path. Nothing here is served by a static file handler.
/// </summary>
public sealed class LocalFileStore
{
    private readonly string root;

    public LocalFileStore(IOptions<StorageOptions> options)
    {
        root = Path.GetFullPath(options.Value.Root);
        foreach (var area in new[] { StorageArea.Quarantine, StorageArea.Sounds, StorageArea.Attachments, StorageArea.Images, $"{StorageArea.Spool}/jobs", $"{StorageArea.Spool}/results" })
            Directory.CreateDirectory(Path.Combine(root, area));
    }

    public static string NewKey() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));

    /// <summary>Resolves an area/key to a path under the root; rejects anything that would escape it.</summary>
    public string PathOf(string area, string key)
    {
        if (key.Length is 0 or > 80 || key.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.')) || key.Contains(".."))
            throw new ArgumentException("Invalid storage key.", nameof(key));
        var full = Path.GetFullPath(Path.Combine(root, area, key));
        if (!full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            throw new ArgumentException("Invalid storage path.", nameof(key));
        return full;
    }

    /// <summary>Streams an upload into the area under a new random key with a hard byte cap; hashes on the way.</summary>
    public async Task<(string Key, long Size, string Sha256)> SaveAsync(string area, Stream source, long maxBytes, CancellationToken ct)
    {
        var key = NewKey();
        var path = PathOf(area, key);
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        long total = 0;
        try
        {
            await using var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 64 * 1024, useAsync: true);
            var buffer = new byte[64 * 1024];
            int read;
            while ((read = await source.ReadAsync(buffer, ct)) > 0)
            {
                total += read;
                if (total > maxBytes) throw AppProblem.TooLarge("file.too_large", $"File is larger than {maxBytes / (1024 * 1024)} MB.");
                sha.AppendData(buffer, 0, read);
                await file.WriteAsync(buffer.AsMemory(0, read), ct);
            }
        }
        catch
        {
            TryDelete(area, key);
            throw;
        }
        return (key, total, Convert.ToHexStringLower(sha.GetHashAndReset()));
    }

    public async Task<string> HashAsync(string area, string key, CancellationToken ct)
    {
        await using var file = File.OpenRead(PathOf(area, key));
        return Convert.ToHexStringLower(await SHA256.HashDataAsync(file, ct));
    }

    public bool Exists(string area, string key) => File.Exists(PathOf(area, key));

    public void TryDelete(string area, string key)
    {
        try
        {
            File.Delete(PathOf(area, key));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException)
        {
            // Orphans are swept by maintenance.
        }
    }

    /// <summary>Writes JSON atomically (temp file + rename) so a polling worker never reads a partial descriptor.</summary>
    public async Task WriteJsonAtomicAsync(string relativeDir, string name, object value, CancellationToken ct)
    {
        var dir = Path.Combine(root, relativeDir);
        var tmp = Path.Combine(dir, $".{name}.{NewKey()}.tmp");
        await File.WriteAllTextAsync(tmp, JsonSerializer.Serialize(value, JsonSerializerOptions.Web), ct);
        File.Move(tmp, Path.Combine(dir, name), overwrite: true);
    }

    public IEnumerable<string> ListJson(string relativeDir) =>
        Directory.EnumerateFiles(Path.Combine(root, relativeDir), "*.json").Select(Path.GetFileName).OfType<string>();

    public string SpoolPath(string relativeDir, string name)
    {
        if (name.Contains('/') || name.Contains('\\') || name.Contains("..")) throw new ArgumentException("Invalid name.", nameof(name));
        return Path.Combine(root, relativeDir, name);
    }
}
