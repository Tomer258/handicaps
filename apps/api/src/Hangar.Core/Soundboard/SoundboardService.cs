using System.Buffers.Binary;
using System.Text.Json;
using Hangar.Core.Common;
using Hangar.Core.Files;
using Hangar.Core.Permissions;
using Hangar.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Hangar.Core.Soundboard;

public sealed class SoundboardOptions
{
    public long MaxUploadBytes { get; set; } = 5 * 1024 * 1024;
    public int MaxSourceSeconds { get; set; } = 30;
    public int MinDurationMs { get; set; } = 100;
    public int MaxDurationMs { get; set; } = 5000;
    public int MaxReadySounds { get; set; } = 300;
    public int MaxOwnedSounds { get; set; } = 30;
    public TimeSpan ValidationTimeout { get; set; } = TimeSpan.FromMinutes(3);

    // Playback policy (soundboard.md §3).
    public int MaxActiveInstallation { get; set; } = 2;
    public TimeSpan MinInterval { get; set; } = TimeSpan.FromSeconds(2);
    public int PerUserPerMinute { get; set; } = 6;
    public int PerRoomPerMinute { get; set; } = 12;
    public TimeSpan StartDeadline { get; set; } = TimeSpan.FromSeconds(3);
    public TimeSpan CompletionGrace { get; set; } = TimeSpan.FromSeconds(2);
    public TimeSpan CommandRetention { get; set; } = TimeSpan.FromHours(24);

    /// <summary>Private worker endpoint (bound to loopback/private network) and the shared key both directions use.</summary>
    public string PublisherUrl { get; set; } = "http://127.0.0.1:8090";
    public string WorkerKey { get; set; } = "";
    public TimeSpan PublisherTokenLifetime { get; set; } = TimeSpan.FromMinutes(10);
}

public sealed record SoundDto(
    Guid Id, string Name, string? Emoji, int DurationMs, Guid OwnerUserId, string State, string? RejectReason,
    bool Favorite, bool CanManage, DateTimeOffset CreatedAt);

public sealed record SoundCatalogDto(IReadOnlyList<SoundDto> Sounds, bool CanUpload, int OwnedCount, int MaxOwned);

public sealed record SoundUpdateRequest(string? Name, string? Emoji);

/// <summary>Post-commit soundboard notifications (implemented by the realtime layer).</summary>
public interface ISoundEventSink
{
    Task CatalogChangedAsync(Guid serverId, Guid soundId, CancellationToken ct);
    Task PlaybackChangedAsync(SoundPlaybackDto playback, CancellationToken ct);
}

/// <summary>
/// Sound library: upload into quarantine + validation job (the validator container normalizes offline), result
/// collection with independent verification, catalog, favorites, rename/delete and authorized previews.
/// </summary>
public sealed class SoundboardService(
    HangarDbContext db,
    PermissionService permissions,
    LocalFileStore files,
    ISoundEventSink events,
    IOptions<SoundboardOptions> options,
    TimeProvider clock)
{
    public const string NormalizeJob = "sound.normalize";
    private SoundboardOptions O => options.Value;

    public async Task<SoundCatalogDto> CatalogAsync(Guid userId, Guid serverId, CancellationToken ct)
    {
        var mask = await permissions.ServerPermissionsAsync(userId, serverId, ct);
        if (mask == Permission.None) throw AppProblem.NotFound("server.not_found", "Server not found.");
        var manageAny = mask.HasFlag(Permission.ManageAnySounds);
        var manageOwn = mask.HasFlag(Permission.ManageOwnSounds);

        // Ready sounds for everyone; pending/rejected ones only for their uploader.
        var rows = await db.SoundboardSounds.AsNoTracking()
            .Where(s => s.ServerId == serverId && (s.State == SoundState.Ready ||
                        (s.OwnerUserId == userId && (s.State == SoundState.Pending || s.State == SoundState.Rejected))))
            .OrderBy(s => s.Name).ThenBy(s => s.Id)
            .ToListAsync(ct);
        var favorites = await db.SoundboardFavorites.AsNoTracking().Where(f => f.UserId == userId).Select(f => f.SoundId).ToListAsync(ct);
        var fav = favorites.ToHashSet();
        var owned = await OwnedCountAsync(userId, serverId, ct);
        return new SoundCatalogDto(
            rows.Select(s => ToDto(s, fav.Contains(s.Id), manageAny || (manageOwn && s.OwnerUserId == userId))).ToList(),
            mask.HasFlag(Permission.UploadSoundboard), owned, O.MaxOwnedSounds);
    }

    public async Task<SoundDto> UploadAsync(Guid userId, Guid serverId, string? name, string? emoji, double? trimStart, double? trimEnd,
        string? originalName, Stream body, CancellationToken ct)
    {
        await permissions.RequireServerAsync(userId, serverId, Permission.UploadSoundboard, ct);
        var cleanName = CleanName(name);
        var cleanEmoji = CleanEmoji(emoji);
        if (trimStart is < 0 || trimEnd is < 0 || (trimStart is not null && trimEnd is not null && trimEnd <= trimStart))
            throw AppProblem.BadRequest("sound.trim", "Trim range is invalid.");
        if (trimStart is not null && trimEnd is not null && (trimEnd - trimStart) * 1000 > O.MaxDurationMs + 50)
            throw AppProblem.Unprocessable("sound.too_long", $"Trim the sound to {O.MaxDurationMs / 1000.0:0.#} seconds or less.");

        if (await OwnedCountAsync(userId, serverId, ct) >= O.MaxOwnedSounds)
            throw AppProblem.Conflict("sound.quota_user", $"You can have at most {O.MaxOwnedSounds} sounds. Delete one first.");
        if (await db.SoundboardSounds.CountAsync(s => s.ServerId == serverId && s.State == SoundState.Ready, ct) >= O.MaxReadySounds)
            throw AppProblem.Conflict("sound.quota_server", "The sound library is full.");

        var (key, size, sha) = await files.SaveAsync(StorageArea.Quarantine, body, O.MaxUploadBytes, ct);
        try
        {
            var mime = await SniffAsync(key, ct) ?? throw AppProblem.Unprocessable("sound.unsupported", "Upload an MP3, WAV or OGG audio file.");
            if (size == 0) throw AppProblem.Unprocessable("sound.empty", "The file is empty.");
            var now = clock.GetUtcNow();
            var asset = new FileAsset
            {
                Id = Guid.CreateVersion7(), ServerId = serverId, OwnerUserId = userId, Purpose = FilePurpose.SoundSource,
                StorageKey = key, Mime = mime, OriginalName = SafeOriginalName(originalName), SizeBytes = size, Sha256 = sha,
                State = FileState.Pending, CreatedAt = now,
            };
            var sound = new SoundboardSound
            {
                Id = Guid.CreateVersion7(), ServerId = serverId, OwnerUserId = userId, Name = cleanName, Emoji = cleanEmoji,
                State = SoundState.Pending, CreatedAt = now,
            };
            var job = new AssetValidationJob
            {
                Id = Guid.CreateVersion7(), AssetId = asset.Id, SoundId = sound.Id, JobType = NormalizeJob, State = ValidationJobState.Queued,
                CreatedAt = now, LeaseExpiresAt = now + O.ValidationTimeout, TrimStartSeconds = trimStart, TrimEndSeconds = trimEnd,
            };
            db.FileAssets.Add(asset);
            db.SoundboardSounds.Add(sound);
            db.AssetValidationJobs.Add(job);
            await db.SaveChangesAsync(ct);

            // The descriptor holds only server-chosen relative names; the validator never sees client paths or names.
            await files.WriteJsonAtomicAsync($"{StorageArea.Spool}/jobs", $"{job.Id:N}.json", new
            {
                jobId = job.Id.ToString("N"),
                input = $"{StorageArea.Quarantine}/{key}",
                output = $"{StorageArea.Sounds}/{OutputKey(job.Id)}",
                trimStart,
                trimEnd,
                minDurationMs = O.MinDurationMs,
                maxDurationMs = O.MaxDurationMs,
                maxSourceSeconds = O.MaxSourceSeconds,
            }, ct);
            await events.CatalogChangedAsync(serverId, sound.Id, ct);
            return ToDto(sound, false, true);
        }
        catch
        {
            files.TryDelete(StorageArea.Quarantine, key);
            throw;
        }
    }

    public async Task<SoundDto> UpdateAsync(Guid userId, Guid soundId, SoundUpdateRequest req, CancellationToken ct)
    {
        var sound = await ManageableAsync(userId, soundId, ct);
        if (req.Name is not null) sound.Name = CleanName(req.Name);
        if (req.Emoji is not null) sound.Emoji = CleanEmoji(req.Emoji);
        await db.SaveChangesAsync(ct);
        await events.CatalogChangedAsync(sound.ServerId, sound.Id, ct);
        var fav = await db.SoundboardFavorites.AnyAsync(f => f.UserId == userId && f.SoundId == soundId, ct);
        return ToDto(sound, fav, true);
    }

    /// <summary>Soft delete: disables new plays at once; active plays are stopped by the playback reconciler.</summary>
    public async Task DeleteAsync(Guid userId, Guid soundId, CancellationToken ct)
    {
        var sound = await ManageableAsync(userId, soundId, ct);
        sound.State = SoundState.Deleted;
        sound.DeletedAt = clock.GetUtcNow();
        await db.SaveChangesAsync(ct);
        await events.CatalogChangedAsync(sound.ServerId, sound.Id, ct);
    }

    public async Task SetFavoriteAsync(Guid userId, Guid soundId, bool favorite, CancellationToken ct)
    {
        var sound = await VisibleReadyAsync(userId, soundId, ct);
        var existing = await db.SoundboardFavorites.FirstOrDefaultAsync(f => f.UserId == userId && f.SoundId == sound.Id, ct);
        if (favorite && existing is null)
            db.SoundboardFavorites.Add(new SoundboardFavorite { UserId = userId, SoundId = sound.Id, CreatedAt = clock.GetUtcNow() });
        else if (!favorite && existing is not null)
            db.SoundboardFavorites.Remove(existing);
        else return;
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException)
        {
            // Concurrent identical toggle: the end state is what was asked for.
        }
    }

    /// <summary>Normalized WAV for local preview only (never broadcast). Returns the file path for range-capable serving.</summary>
    public async Task<string> PreviewPathAsync(Guid userId, Guid soundId, CancellationToken ct)
    {
        var sound = await VisibleReadyAsync(userId, soundId, ct);
        var key = await db.SoundAssetVersions.Where(v => v.Id == sound.ActiveVersionId)
            .Join(db.FileAssets, v => v.FileAssetId, f => f.Id, (v, f) => f.StorageKey).FirstOrDefaultAsync(ct)
            ?? throw AppProblem.NotFound("sound.not_found", "Sound not found.");
        return files.PathOf(StorageArea.Sounds, key);
    }

    // ---- validation results (collected by ValidationCollector) ----------------------------------

    /// <summary>
    /// Applies a validator result for a sound job. The API re-verifies the output itself (path, WAV format, duration,
    /// hash) instead of trusting the descriptor, then publishes an immutable version.
    /// </summary>
    public async Task ApplyResultAsync(AssetValidationJob job, ValidationResult result, CancellationToken ct)
    {
        if (!result.Ok)
        {
            await FailAsync(job, CleanCode(result.Error), ct);
            return;
        }

        var outKey = OutputKey(job.Id);
        var info = files.Exists(StorageArea.Sounds, outKey) ? ReadWav(files.PathOf(StorageArea.Sounds, outKey)) : null;
        if (info is null || info.Value.DurationMs < O.MinDurationMs || info.Value.DurationMs > O.MaxDurationMs + 20)
        {
            files.TryDelete(StorageArea.Sounds, outKey);
            await FailAsync(job, info is null ? "output_invalid" : "duration", ct);
            return;
        }
        var duration = Math.Min(info.Value.DurationMs, O.MaxDurationMs);
        var sha = await files.HashAsync(StorageArea.Sounds, outKey, ct);
        var sound = await db.SoundboardSounds.FirstAsync(s => s.Id == job.SoundId, ct);
        var source = await db.FileAssets.FirstAsync(f => f.Id == job.AssetId, ct);
        var now = clock.GetUtcNow();
        var ready = new FileAsset
        {
            Id = Guid.CreateVersion7(), ServerId = sound.ServerId, OwnerUserId = sound.OwnerUserId, Purpose = FilePurpose.SoundReady,
            StorageKey = outKey, Mime = "audio/wav", OriginalName = "sound.wav", SizeBytes = info.Value.Size, Sha256 = sha,
            State = FileState.Ready, CreatedAt = now,
        };
        var versionNumber = await db.SoundAssetVersions.Where(v => v.SoundId == sound.Id).MaxAsync(v => (int?)v.VersionNumber, ct) ?? 0;
        var version = new SoundAssetVersion
        {
            Id = Guid.CreateVersion7(), SoundId = sound.Id, FileAssetId = ready.Id, VersionNumber = versionNumber + 1, Sha256 = sha,
            SampleRate = 48000, Channels = 2, Loudness = result.Loudness, TruePeak = result.TruePeak, DurationMs = duration, CreatedAt = now,
        };
        db.FileAssets.Add(ready);
        db.SoundAssetVersions.Add(version);
        job.State = ValidationJobState.Succeeded;
        job.ResultHash = sha;
        source.State = FileState.Deleted;
        source.DeletedAt = now;
        if (sound.State == SoundState.Pending)
        {
            sound.State = SoundState.Ready;
            sound.DurationMs = duration;
            sound.ActiveVersionId = version.Id;
        }
        await db.SaveChangesAsync(ct);
        files.TryDelete(StorageArea.Quarantine, source.StorageKey); // the original upload is not kept after validation
        await events.CatalogChangedAsync(sound.ServerId, sound.Id, ct);
    }

    public async Task FailAsync(AssetValidationJob job, string code, CancellationToken ct)
    {
        job.State = ValidationJobState.Failed;
        job.ErrorCode = code;
        var sound = await db.SoundboardSounds.FirstOrDefaultAsync(s => s.Id == job.SoundId, ct);
        var source = await db.FileAssets.FirstOrDefaultAsync(f => f.Id == job.AssetId, ct);
        if (sound is { State: SoundState.Pending })
        {
            sound.State = SoundState.Rejected;
            sound.RejectReason = code;
        }
        if (source is not null)
        {
            source.State = FileState.Rejected;
            files.TryDelete(StorageArea.Quarantine, source.StorageKey);
        }
        await db.SaveChangesAsync(ct);
        try
        {
            File.Delete(files.SpoolPath($"{StorageArea.Spool}/jobs", $"{job.Id:N}.json"));
        }
        catch (IOException)
        {
        }
        if (sound is not null) await events.CatalogChangedAsync(sound.ServerId, sound.Id, ct);
    }

    // ---- helpers --------------------------------------------------------------------------------

    public static string OutputKey(Guid jobId) => $"{jobId:N}.wav";

    /// <summary>Strict canonical check: RIFF/WAVE, PCM, 48 kHz, stereo, 16-bit; returns duration from the data chunk.</summary>
    public static (int DurationMs, long Size)? ReadWav(string path)
    {
        using var f = File.OpenRead(path);
        if (f.Length is < 44 or > 4 * 1024 * 1024) return null;
        Span<byte> head = stackalloc byte[12];
        if (f.Read(head) != 12 || !head[..4].SequenceEqual("RIFF"u8) || !head[8..12].SequenceEqual("WAVE"u8)) return null;
        bool fmtOk = false;
        Span<byte> chunk = stackalloc byte[8];
        while (f.Read(chunk) == 8)
        {
            var size = BinaryPrimitives.ReadUInt32LittleEndian(chunk[4..]);
            if (chunk[..4].SequenceEqual("fmt "u8))
            {
                if (size < 16) return null;
                var fmt = new byte[size];
                if (f.Read(fmt) != size) return null;
                var format = BinaryPrimitives.ReadUInt16LittleEndian(fmt);
                var channels = BinaryPrimitives.ReadUInt16LittleEndian(fmt.AsSpan(2));
                var rate = BinaryPrimitives.ReadUInt32LittleEndian(fmt.AsSpan(4));
                var bits = BinaryPrimitives.ReadUInt16LittleEndian(fmt.AsSpan(14));
                fmtOk = format is 1 or 0xFFFE && channels == 2 && rate == 48000 && bits == 16;
                if (!fmtOk) return null;
            }
            else if (chunk[..4].SequenceEqual("data"u8))
            {
                if (!fmtOk || size == 0 || size % 4 != 0 || f.Position + size > f.Length) return null;
                return ((int)(size / 4 * 1000L / 48000), f.Length);
            }
            else
            {
                f.Seek(size + (size & 1), SeekOrigin.Current);
            }
        }
        return null;
    }

    private async Task<string?> SniffAsync(string key, CancellationToken ct)
    {
        await using var f = File.OpenRead(files.PathOf(StorageArea.Quarantine, key));
        var head = new byte[12];
        var n = await f.ReadAtLeastAsync(head, 12, throwOnEndOfStream: false, ct);
        if (n >= 12 && head.AsSpan(0, 4).SequenceEqual("RIFF"u8) && head.AsSpan(8, 4).SequenceEqual("WAVE"u8)) return "audio/wav";
        if (n >= 4 && head.AsSpan(0, 4).SequenceEqual("OggS"u8)) return "audio/ogg";
        if (n >= 3 && head.AsSpan(0, 3).SequenceEqual("ID3"u8)) return "audio/mpeg";
        if (n >= 2 && head[0] == 0xFF && (head[1] & 0xE0) == 0xE0) return "audio/mpeg"; // MPEG audio frame sync
        return null;
    }

    private Task<int> OwnedCountAsync(Guid userId, Guid serverId, CancellationToken ct) =>
        db.SoundboardSounds.CountAsync(s => s.ServerId == serverId && s.OwnerUserId == userId &&
                                            (s.State == SoundState.Ready || s.State == SoundState.Pending), ct);

    private async Task<SoundboardSound> ManageableAsync(Guid userId, Guid soundId, CancellationToken ct)
    {
        var sound = await db.SoundboardSounds.FirstOrDefaultAsync(s => s.Id == soundId && s.State != SoundState.Deleted, ct)
                    ?? throw AppProblem.NotFound("sound.not_found", "Sound not found.");
        var mask = await permissions.ServerPermissionsAsync(userId, sound.ServerId, ct);
        if (mask == Permission.None) throw AppProblem.NotFound("sound.not_found", "Sound not found.");
        var allowed = mask.HasFlag(Permission.ManageAnySounds) || (sound.OwnerUserId == userId && mask.HasFlag(Permission.ManageOwnSounds));
        if (!allowed) throw AppProblem.Forbidden("sound.manage_denied", "You can only manage your own sounds.");
        return sound;
    }

    private async Task<SoundboardSound> VisibleReadyAsync(Guid userId, Guid soundId, CancellationToken ct)
    {
        var sound = await db.SoundboardSounds.AsNoTracking().FirstOrDefaultAsync(s => s.Id == soundId && s.State == SoundState.Ready, ct)
                    ?? throw AppProblem.NotFound("sound.not_found", "Sound not found.");
        if (await permissions.ServerPermissionsAsync(userId, sound.ServerId, ct) == Permission.None)
            throw AppProblem.NotFound("sound.not_found", "Sound not found.");
        return sound;
    }

    private static SoundDto ToDto(SoundboardSound s, bool favorite, bool canManage) => new(
        s.Id, s.Name, s.Emoji, s.DurationMs, s.OwnerUserId, s.State.ToString().ToLowerInvariant(), s.RejectReason, favorite, canManage, s.CreatedAt);

    private static string CleanName(string? name)
    {
        var n = (name ?? "").Trim();
        n = new string(n.Where(c => !char.IsControl(c)).ToArray());
        if (n.Length is 0 or > 60) throw AppProblem.BadRequest("sound.name", "Name must be 1–60 characters.");
        return n;
    }

    /// <summary>Optional single emoji (one grapheme, no letters/digits/markup).</summary>
    private static string? CleanEmoji(string? emoji)
    {
        var e = (emoji ?? "").Trim();
        if (e.Length == 0) return null;
        if (e.Length > 16 || System.Globalization.StringInfo.ParseCombiningCharacters(e).Length != 1 || e.Any(c => c < 0x80))
            throw AppProblem.BadRequest("sound.emoji", "Icon must be a single emoji.");
        return e;
    }

    private static string SafeOriginalName(string? name)
    {
        var n = Path.GetFileName(name ?? "sound");
        n = new string(n.Where(c => !char.IsControl(c) && c is not ('"' or '\\' or '/')).ToArray());
        return n.Length == 0 ? "sound" : n[..Math.Min(n.Length, 200)];
    }

    private static string CleanCode(string? code)
    {
        var c = new string((code ?? "invalid").Where(ch => char.IsAsciiLetterOrDigit(ch) || ch is '_' or '.').ToArray());
        return c.Length == 0 ? "invalid" : c[..Math.Min(c.Length, 60)];
    }
}
