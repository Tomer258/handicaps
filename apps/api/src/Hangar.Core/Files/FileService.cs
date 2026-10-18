using System.Buffers.Binary;
using System.Text;
using Hangar.Core.Common;
using Hangar.Core.Permissions;
using Hangar.Core.Persistence;
using Hangar.Core.Soundboard;
using Hangar.Core.Users;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Hangar.Core.Files;

public sealed class AttachmentOptions
{
    public long MaxImageBytes { get; set; } = 10 * 1024 * 1024;
    public long MaxTextBytes { get; set; } = 1024 * 1024;
    public long MaxAvatarBytes { get; set; } = 5 * 1024 * 1024;
    public int MaxPixels { get; set; } = 40_000_000;
    public int MaxSide { get; set; } = 12_000;
    public int MaxOutputSide { get; set; } = 2560;
    /// <summary>Unlinked attachments are deleted after this grace (data-model-and-contracts.md §7).</summary>
    public TimeSpan OrphanGrace { get; set; } = TimeSpan.FromHours(24);
    public TimeSpan ValidationTimeout { get; set; } = TimeSpan.FromMinutes(3);
}

public sealed record FileStatusDto(Guid Id, string Name, string Mime, long Size, int? Width, int? Height, string State, string? RejectReason);

/// <summary>A readable file: path, served type, and whether it may render inline.</summary>
public sealed record FileContent(string Path, string Mime, string DownloadName, bool Inline);

/// <summary>Validator result descriptor (spool/results). Every field is re-verified by the API.</summary>
public sealed record ValidationResult(string JobId, bool Ok, string? Error, double? Loudness, double? TruePeak, int? Width, int? Height);

/// <summary>
/// Message attachments and avatars (ADR 010, security-and-operations.md file checks). Uploads land in quarantine; images
/// are decoded/re-encoded to WebP by the isolated validator under pixel limits; plain text is validated here and always
/// downloads with attachment disposition. Anything else is refused until a malware-scanning stage exists.
/// Reads are authorized by the parent message's channel (attachments) or by sharing a server (avatars).
/// </summary>
public sealed class FileService(
    HangarDbContext db,
    PermissionService permissions,
    LocalFileStore files,
    IProfileChangeSink profiles,
    IOptions<AttachmentOptions> options,
    TimeProvider clock,
    ILogger<FileService> log)
{
    public const string ImageJob = "image.normalize";
    private static readonly HashSet<string> TextExtensions = [".txt", ".log", ".md", ".csv", ".json"];
    private AttachmentOptions O => options.Value;

    public async Task<FileStatusDto> UploadAttachmentAsync(Guid userId, Guid serverId, string? fileName, Stream body, CancellationToken ct)
    {
        await permissions.RequireServerAsync(userId, serverId, Permission.AttachFiles, ct);
        var name = SafeName(fileName);
        var (key, size, sha) = await files.SaveAsync(StorageArea.Quarantine, body, Math.Max(O.MaxImageBytes, O.MaxTextBytes), ct);
        try
        {
            if (size == 0) throw AppProblem.Unprocessable("file.empty", "The file is empty.");
            var kind = await SniffAsync(key, ct);
            if (kind == "image")
            {
                if (size > O.MaxImageBytes) throw AppProblem.TooLarge("file.too_large", $"Images can be up to {O.MaxImageBytes / (1024 * 1024)} MB.");
                return ToDto(await QueueImageAsync(userId, serverId, FilePurpose.Attachment, name, key, size, sha, "attachment", ct));
            }
            if (kind is null && TextExtensions.Contains(Path.GetExtension(name).ToLowerInvariant()) && size <= O.MaxTextBytes && await IsPlainTextAsync(key, ct))
            {
                // Text is final as uploaded: move it out of quarantine into the attachment area under a new key.
                var finalKey = LocalFileStore.NewKey();
                File.Move(files.PathOf(StorageArea.Quarantine, key), files.PathOf(StorageArea.Attachments, finalKey));
                var asset = NewAsset(userId, serverId, FilePurpose.Attachment, finalKey, "text/plain", name, size, sha, FileState.Ready);
                db.FileAssets.Add(asset);
                await db.SaveChangesAsync(ct);
                return ToDto(asset);
            }
            throw AppProblem.Unprocessable("file.unsupported", "Only images (PNG, JPEG, GIF, WebP) and plain-text files can be attached for now.");
        }
        catch
        {
            files.TryDelete(StorageArea.Quarantine, key);
            throw;
        }
    }

    public async Task<FileStatusDto> UploadAvatarAsync(Guid userId, string? fileName, Stream body, CancellationToken ct)
    {
        var serverId = await db.ServerMembers.Where(m => m.UserId == userId && m.RemovedAt == null).Select(m => m.ServerId).FirstOrDefaultAsync(ct);
        if (serverId == Guid.Empty) throw AppProblem.Forbidden("avatar.no_server", "Join a server first.");
        var (key, size, sha) = await files.SaveAsync(StorageArea.Quarantine, body, O.MaxAvatarBytes, ct);
        try
        {
            if (await SniffAsync(key, ct) != "image") throw AppProblem.Unprocessable("file.unsupported", "Use a PNG, JPEG, GIF or WebP image.");
            return ToDto(await QueueImageAsync(userId, serverId, FilePurpose.Avatar, SafeName(fileName), key, size, sha, "avatar", ct));
        }
        catch
        {
            files.TryDelete(StorageArea.Quarantine, key);
            throw;
        }
    }

    public async Task RemoveAvatarAsync(Guid userId, CancellationToken ct)
    {
        var user = await db.Users.FirstAsync(u => u.Id == userId, ct);
        if (user.AvatarAssetId is not { } old) return;
        user.AvatarAssetId = null;
        await db.SaveChangesAsync(ct);
        await DeleteAssetAsync(old, ct);
        await profiles.ProfileChangedAsync(userId, ct);
    }

    /// <summary>Upload status for the uploader only (polled while the validator works).</summary>
    public async Task<FileStatusDto> StatusAsync(Guid userId, Guid id, CancellationToken ct)
    {
        var asset = await db.FileAssets.AsNoTracking().FirstOrDefaultAsync(f => f.Id == id && f.OwnerUserId == userId &&
                        (f.Purpose == FilePurpose.Attachment || f.Purpose == FilePurpose.Avatar), ct)
                    ?? throw AppProblem.NotFound("file.not_found", "File not found.");
        var reason = asset.State == FileState.Rejected
            ? await db.AssetValidationJobs.Where(j => j.AssetId == id).OrderByDescending(j => j.CreatedAt).Select(j => j.ErrorCode).FirstOrDefaultAsync(ct)
            : null;
        return ToDto(asset) with { RejectReason = reason };
    }

    /// <summary>
    /// Attachment read: linked → the caller must currently see the message's channel (and the message must exist);
    /// unlinked → only its uploader (composer preview).
    /// </summary>
    public async Task<FileContent> ReadAttachmentAsync(Guid userId, Guid id, CancellationToken ct)
    {
        var asset = await db.FileAssets.AsNoTracking().FirstOrDefaultAsync(f => f.Id == id && f.Purpose == FilePurpose.Attachment && f.State == FileState.Ready, ct)
                    ?? throw AppProblem.NotFound("file.not_found", "File not found.");
        var channelId = await db.MessageAttachments.Where(a => a.FileAssetId == id)
            .Join(db.Messages, a => a.MessageId, m => m.Id, (a, m) => new { m.ChannelId, m.DeletedAt })
            .FirstOrDefaultAsync(ct);
        if (channelId is null)
        {
            if (asset.OwnerUserId != userId) throw AppProblem.NotFound("file.not_found", "File not found.");
        }
        else
        {
            if (channelId.DeletedAt is not null) throw AppProblem.NotFound("file.not_found", "File not found.");
            var channel = await db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == channelId.ChannelId, ct);
            if (channel is null || !(await permissions.ChannelPermissionsAsync(userId, channel, ct)).HasFlag(Permission.ViewChannel))
                throw AppProblem.NotFound("file.not_found", "File not found.");
        }
        var image = asset.Mime == "image/webp";
        return new FileContent(files.PathOf(image ? StorageArea.Images : StorageArea.Attachments, asset.StorageKey), asset.Mime, asset.OriginalName, image);
    }

    /// <summary>Avatar read: any signed-in user who shares a server with its owner.</summary>
    public async Task<FileContent> ReadAvatarAsync(Guid userId, Guid id, CancellationToken ct)
    {
        var asset = await db.FileAssets.AsNoTracking().FirstOrDefaultAsync(f => f.Id == id && f.Purpose == FilePurpose.Avatar && f.State == FileState.Ready, ct)
                    ?? throw AppProblem.NotFound("file.not_found", "File not found.");
        var mine = db.ServerMembers.Where(m => m.UserId == userId && m.RemovedAt == null).Select(m => m.ServerId);
        var shares = asset.OwnerUserId == userId ||
                     await db.ServerMembers.AnyAsync(m => m.UserId == asset.OwnerUserId && m.RemovedAt == null && mine.Contains(m.ServerId), ct);
        if (!shares) throw AppProblem.NotFound("file.not_found", "File not found.");
        return new FileContent(files.PathOf(StorageArea.Images, asset.StorageKey), asset.Mime, "avatar.webp", true);
    }

    // ---- validator results ------------------------------------------------------------------------

    /// <summary>Re-verifies the validator output (WebP container, dimensions, hash) before publishing it.</summary>
    public async Task ApplyImageResultAsync(AssetValidationJob job, ValidationResult result, CancellationToken ct)
    {
        var asset = await db.FileAssets.FirstOrDefaultAsync(f => f.Id == job.AssetId, ct);
        if (asset is null || asset.State != FileState.Pending)
        {
            job.State = ValidationJobState.Failed;
            job.ErrorCode = "asset_gone";
            await db.SaveChangesAsync(ct);
            return;
        }
        if (!result.Ok)
        {
            await FailImageAsync(job, CleanCode(result.Error), ct);
            return;
        }
        var outKey = ImageOutputKey(job.Id);
        var dims = files.Exists(StorageArea.Images, outKey) ? ReadWebp(files.PathOf(StorageArea.Images, outKey)) : null;
        var maxSide = asset.Purpose == FilePurpose.Avatar ? 256 : O.MaxOutputSide;
        if (dims is not { } d || d.Width > maxSide || d.Height > maxSide)
        {
            files.TryDelete(StorageArea.Images, outKey);
            await FailImageAsync(job, "output_invalid", ct);
            return;
        }
        var quarantineKey = asset.StorageKey;
        asset.StorageKey = outKey;
        asset.Mime = "image/webp";
        asset.SizeBytes = new FileInfo(files.PathOf(StorageArea.Images, outKey)).Length;
        asset.Sha256 = await files.HashAsync(StorageArea.Images, outKey, ct);
        asset.Width = d.Width;
        asset.Height = d.Height;
        asset.State = FileState.Ready;
        asset.OriginalName = Path.ChangeExtension(asset.OriginalName, ".webp");
        job.State = ValidationJobState.Succeeded;
        job.ResultHash = asset.Sha256;

        Guid? replaced = null;
        if (asset.Purpose == FilePurpose.Avatar)
        {
            var user = await db.Users.FirstAsync(u => u.Id == asset.OwnerUserId, ct);
            replaced = user.AvatarAssetId;
            user.AvatarAssetId = asset.Id;
        }
        await db.SaveChangesAsync(ct);
        files.TryDelete(StorageArea.Quarantine, quarantineKey);
        if (asset.Purpose == FilePurpose.Avatar)
        {
            if (replaced is { } old) await DeleteAssetAsync(old, ct);
            await profiles.ProfileChangedAsync(asset.OwnerUserId, ct);
        }
    }

    public async Task FailImageAsync(AssetValidationJob job, string code, CancellationToken ct)
    {
        job.State = ValidationJobState.Failed;
        job.ErrorCode = code;
        var asset = await db.FileAssets.FirstOrDefaultAsync(f => f.Id == job.AssetId, ct);
        if (asset is { State: FileState.Pending })
        {
            asset.State = FileState.Rejected;
            files.TryDelete(StorageArea.Quarantine, asset.StorageKey);
        }
        await db.SaveChangesAsync(ct);
        log.LogInformation("Image {AssetId} rejected: {Code}", job.AssetId, code);
    }

    /// <summary>Deletes unlinked attachments past the grace period and purges rejected uploads.</summary>
    public async Task<int> CollectGarbageAsync(CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var orphanBefore = now - O.OrphanGrace;
        var orphans = await db.FileAssets
            .Where(f => f.Purpose == FilePurpose.Attachment && f.State == FileState.Ready && f.CreatedAt < orphanBefore &&
                        !db.MessageAttachments.Any(a => a.FileAssetId == f.Id))
            .Select(f => f.Id).Take(200).ToListAsync(ct);
        foreach (var id in orphans) await DeleteAssetAsync(id, ct);
        // Attachments of deleted messages: remove bytes, then the rows (no references remain).
        var deleted = await db.FileAssets.Where(f => f.Purpose == FilePurpose.Attachment && f.State == FileState.Deleted)
            .Select(f => new { f.Id, f.StorageKey, f.Mime }).Take(500).ToListAsync(ct);
        foreach (var d in deleted) files.TryDelete(d.Mime == "image/webp" ? StorageArea.Images : StorageArea.Attachments, d.StorageKey);
        var ids = deleted.Select(d => d.Id).ToList();
        await db.FileAssets.Where(f => ids.Contains(f.Id)).ExecuteDeleteAsync(ct);
        var rejected = await db.FileAssets
            .Where(f => (f.Purpose == FilePurpose.Attachment || f.Purpose == FilePurpose.Avatar) && f.State == FileState.Rejected && f.CreatedAt < now.AddHours(-1))
            .ExecuteDeleteAsync(ct);
        return orphans.Count + deleted.Count + rejected;
    }

    // ---- helpers ----------------------------------------------------------------------------------

    public static string ImageOutputKey(Guid jobId) => $"{jobId:N}.webp";

    private async Task<FileAsset> QueueImageAsync(Guid userId, Guid serverId, FilePurpose purpose, string name, string key, long size, string sha,
        string mode, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var asset = NewAsset(userId, serverId, purpose, key, "application/octet-stream", name, size, sha, FileState.Pending);
        var job = new AssetValidationJob
        {
            Id = Guid.CreateVersion7(), AssetId = asset.Id, SoundId = Guid.Empty, JobType = ImageJob, State = ValidationJobState.Queued,
            CreatedAt = now, LeaseExpiresAt = now + O.ValidationTimeout,
        };
        db.FileAssets.Add(asset);
        db.AssetValidationJobs.Add(job);
        await db.SaveChangesAsync(ct);
        await files.WriteJsonAtomicAsync($"{StorageArea.Spool}/jobs", $"{job.Id:N}.json", new
        {
            type = ImageJob,
            jobId = job.Id.ToString("N"),
            input = $"{StorageArea.Quarantine}/{key}",
            output = $"{StorageArea.Images}/{ImageOutputKey(job.Id)}",
            mode,
            maxPixels = O.MaxPixels,
            maxSide = O.MaxSide,
            maxOutputSide = O.MaxOutputSide,
        }, ct);
        return asset;
    }

    private FileAsset NewAsset(Guid userId, Guid serverId, FilePurpose purpose, string key, string mime, string name, long size, string sha, FileState state) => new()
    {
        Id = Guid.CreateVersion7(), ServerId = serverId, OwnerUserId = userId, Purpose = purpose, StorageKey = key, Mime = mime,
        OriginalName = name, SizeBytes = size, Sha256 = sha, State = state, CreatedAt = clock.GetUtcNow(),
    };

    private async Task DeleteAssetAsync(Guid id, CancellationToken ct)
    {
        var asset = await db.FileAssets.FirstOrDefaultAsync(f => f.Id == id, ct);
        if (asset is null || asset.State == FileState.Deleted) return;
        var area = asset.Mime == "image/webp" ? StorageArea.Images : asset.State == FileState.Pending ? StorageArea.Quarantine : StorageArea.Attachments;
        asset.State = FileState.Deleted;
        asset.DeletedAt = clock.GetUtcNow();
        await db.SaveChangesAsync(ct);
        files.TryDelete(area, asset.StorageKey);
    }

    /// <summary>Magic-byte detection (the client's type and extension are never trusted). Null = not an accepted image.</summary>
    private async Task<string?> SniffAsync(string key, CancellationToken ct)
    {
        await using var f = File.OpenRead(files.PathOf(StorageArea.Quarantine, key));
        var h = new byte[12];
        var n = await f.ReadAtLeastAsync(h, 12, throwOnEndOfStream: false, ct);
        if (n >= 8 && h.AsSpan(0, 8).SequenceEqual(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A })) return "image";
        if (n >= 3 && h[0] == 0xFF && h[1] == 0xD8 && h[2] == 0xFF) return "image";
        if (n >= 6 && (h.AsSpan(0, 6).SequenceEqual("GIF87a"u8) || h.AsSpan(0, 6).SequenceEqual("GIF89a"u8))) return "image";
        if (n >= 12 && h.AsSpan(0, 4).SequenceEqual("RIFF"u8) && h.AsSpan(8, 4).SequenceEqual("WEBP"u8)) return "image";
        return null;
    }

    /// <summary>Strict UTF-8 without NUL or other C0 controls except tab/newline/carriage return.</summary>
    private async Task<bool> IsPlainTextAsync(string key, CancellationToken ct)
    {
        var bytes = await File.ReadAllBytesAsync(files.PathOf(StorageArea.Quarantine, key), ct);
        string text;
        try
        {
            text = new UTF8Encoding(false, true).GetString(bytes);
        }
        catch (DecoderFallbackException)
        {
            return false;
        }
        return !text.Any(c => c < 0x20 && c is not ('\t' or '\n' or '\r'));
    }

    /// <summary>Reads canvas dimensions from a RIFF/WEBP file (VP8, VP8L or VP8X first chunk).</summary>
    public static (int Width, int Height)? ReadWebp(string path)
    {
        using var f = File.OpenRead(path);
        if (f.Length is < 30 or > 64 * 1024 * 1024) return null;
        Span<byte> b = stackalloc byte[30];
        if (f.Read(b) != 30 || !b[..4].SequenceEqual("RIFF"u8) || !b[8..12].SequenceEqual("WEBP"u8)) return null;
        var chunk = Encoding.ASCII.GetString(b[12..16]);
        return chunk switch
        {
            "VP8X" => (1 + (b[24] | b[25] << 8 | b[26] << 16), 1 + (b[27] | b[28] << 8 | b[29] << 16)),
            "VP8 " when b[23] == 0x9D && b[24] == 0x01 && b[25] == 0x2A =>
                (BinaryPrimitives.ReadUInt16LittleEndian(b[26..]) & 0x3FFF, BinaryPrimitives.ReadUInt16LittleEndian(b[28..]) & 0x3FFF),
            "VP8L" when b[20] == 0x2F => VP8L(BinaryPrimitives.ReadUInt32LittleEndian(b[21..])),
            _ => null,
        };

        static (int, int) VP8L(uint bits) => ((int)(bits & 0x3FFF) + 1, (int)((bits >> 14) & 0x3FFF) + 1);
    }

    private static string SafeName(string? name)
    {
        var n = Path.GetFileName(name ?? "file");
        n = new string(n.Where(c => !char.IsControl(c) && c is not ('"' or '\\' or '/' or ':' or '*' or '?' or '<' or '>' or '|')).ToArray()).Trim();
        return n.Length == 0 ? "file" : n[..Math.Min(n.Length, 120)];
    }

    private static string CleanCode(string? code)
    {
        var c = new string((code ?? "invalid").Where(ch => char.IsAsciiLetterOrDigit(ch) || ch is '_' or '.').ToArray());
        return c.Length == 0 ? "invalid" : c[..Math.Min(c.Length, 60)];
    }

    private static FileStatusDto ToDto(FileAsset a) => new(a.Id, a.OriginalName, a.Mime, a.SizeBytes, a.Width, a.Height,
        a.State.ToString().ToLowerInvariant(), null);
}
