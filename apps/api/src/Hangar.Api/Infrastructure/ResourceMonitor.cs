using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Hangar.Api.Realtime;
using Hangar.Core.Files;
using Hangar.Core.Media;
using Hangar.Core.Permissions;
using Hangar.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Hangar.Api.Infrastructure;

public sealed class ResourceOptions
{
    /// <summary>Seconds between samples; the history keeps one hour.</summary>
    public int SampleSeconds { get; set; } = 10;

    /// <summary>
    /// Per-service usage written by the ops monitor from the containers' cgroups (production only). Missing or older
    /// than a minute → the page shows the API process alone.
    /// </summary>
    public string? ServicesFile { get; set; }

    /// <summary>
    /// Development only: read `docker stats` for containers whose name starts with this (e.g. "hangar-dev-") and list
    /// them next to the API process, which runs outside Docker there. Empty = off.
    /// </summary>
    public string? DockerStatsPrefix { get; set; }
}

public sealed record ServiceUsageDto(string Name, double CpuPercent, double MemoryMb, double? MemoryLimitMb);

/// <summary>One sample. CPU is a percentage of the whole machine (all cores = 100).</summary>
public sealed record ResourcePointDto(DateTimeOffset At, double ApiCpu, double ApiMemoryMb, double? HostCpu, double? HostMemoryUsedMb,
    double ProjectCpu, double ProjectMemoryMb);

public sealed record ApiProcessDto(double CpuPercent, double MemoryMb, double ManagedHeapMb, int Threads, double UptimeSeconds, string Runtime);
public sealed record HostDto(string Os, int Cores, double? CpuPercent, double? MemoryTotalMb, double? MemoryUsedMb);
public sealed record DiskDto(string Path, double TotalGb, double FreeGb, double? FilesMb, DateTimeOffset? FilesMeasuredAt);
public sealed record TableSizeDto(string Name, double SizeMb);
public sealed record DatabaseDto(double SizeMb, IReadOnlyList<TableSizeDto> Largest);
public sealed record LiveDto(int OnlineUsers, int Connections, int InVoice, int Screens, int Cameras);

public sealed record SystemSnapshotDto(
    DateTimeOffset At,
    int SampleSeconds,
    /// <summary>"services" when per-service figures from the ops monitor are fresh, else "api" (this process only).</summary>
    string ProjectScope,
    double ProjectCpu,
    double ProjectMemoryMb,
    ApiProcessDto Api,
    HostDto Host,
    IReadOnlyList<ServiceUsageDto> Services,
    DiskDto? Disk,
    DatabaseDto? Database,
    LiveDto Live,
    IReadOnlyList<ResourcePointDto> History);

/// <summary>Samples this process, the host and (when available) every project container, keeping an hour of history.</summary>
public sealed class ResourceSampler(IOptions<ResourceOptions> options, IOptions<StorageOptions> storage, ILogger<ResourceSampler> log)
    : BackgroundService
{
    private readonly Lock _gate = new();
    private readonly Queue<ResourcePointDto> _history = new();
    private readonly DateTimeOffset _started = DateTimeOffset.UtcNow;
    private TimeSpan _prevProcCpu;
    private long _prevWallTicks;
    private (ulong Busy, ulong Total)? _prevHost;
    private ResourcePointDto? _last;
    private bool _primed;
    private IReadOnlyList<ServiceUsageDto> _services = [];
    private double? _hostMemTotal;
    private (double Mb, DateTimeOffset At)? _files;
    private DateTimeOffset _filesNext = DateTimeOffset.MinValue;
    private IReadOnlyList<ServiceUsageDto> _docker = [];
    private int _dockerBusy;
    private long _viewedTicks;
    private double? _dockerVmMb;

    public int SampleSeconds => Math.Clamp(options.Value.SampleSeconds, 2, 300);
    private int Capacity => 3600 / SampleSeconds;

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        Sample();
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(SampleSeconds));
        while (await timer.WaitForNextTickAsync(ct))
        {
            try
            {
                Sample();
                if (DateTimeOffset.UtcNow >= _filesNext)
                {
                    _filesNext = DateTimeOffset.UtcNow.AddMinutes(5);
                    var mb = await Task.Run(() => DirectoryMb(Path.GetFullPath(storage.Value.Root)), ct);
                    lock (_gate) _files = (mb, DateTimeOffset.UtcNow);
                }
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                log.LogWarning(e, "Resource sample failed");
            }
        }
    }

    public void Sample()
    {
        var now = DateTimeOffset.UtcNow;
        using var proc = Process.GetCurrentProcess();
        var cpuTime = proc.TotalProcessorTime;
        var wall = Stopwatch.GetTimestamp();
        double apiCpu = 0;
        if (_prevWallTicks != 0)
        {
            var elapsed = Stopwatch.GetElapsedTime(_prevWallTicks, wall).TotalSeconds;
            if (elapsed > 0) apiCpu = Math.Clamp(100 * (cpuTime - _prevProcCpu).TotalSeconds / (elapsed * Environment.ProcessorCount), 0, 100);
        }
        _prevProcCpu = cpuTime;
        _prevWallTicks = wall;
        var apiMem = proc.WorkingSet64 / 1048576.0;

        double? hostCpu = null;
        var times = HostStats.CpuTimes();
        if (times is { } t && _prevHost is { } p && t.Total > p.Total)
            hostCpu = Math.Clamp(100.0 * (t.Busy - p.Busy) / (t.Total - p.Total), 0, 100);
        _prevHost = times;
        var mem = HostStats.Memory();

        var services = ReadServices(now);
        if (services.Count == 0 && !string.IsNullOrWhiteSpace(options.Value.DockerStatsPrefix))
        {
            // Only while someone watches the System page: docker stats itself costs the daemon some CPU.
            if (DateTimeOffset.UtcNow.UtcTicks - Interlocked.Read(ref _viewedTicks) < TimeSpan.FromMinutes(2).Ticks)
                RefreshDockerStats(options.Value.DockerStatsPrefix);
            List<ServiceUsageDto> local = [new("api", Round(apiCpu), Round(apiMem), null), .. _docker];
            services = local.OrderByDescending(s => s.MemoryMb).ToList();
        }
        var (projectCpu, projectMem) = services.Count > 0
            ? (services.Sum(s => s.CpuPercent), services.Sum(s => s.MemoryMb))
            : (apiCpu, apiMem);

        var point = new ResourcePointDto(now, Round(apiCpu), Round(apiMem), hostCpu is { } h ? Round(h) : null,
            mem is { } m ? Round(m.TotalMb - m.AvailableMb) : null, Round(projectCpu), Round(projectMem));
        lock (_gate)
        {
            _last = point;
            _services = services;
            _hostMemTotal = mem?.TotalMb;
            // The first sample has no previous reading to measure CPU against.
            if (_primed) _history.Enqueue(point);
            _primed = true;
            while (_history.Count > Capacity) _history.Dequeue();
        }
    }

    private IReadOnlyList<ServiceUsageDto> ReadServices(DateTimeOffset now)
    {
        var path = options.Value.ServicesFile;
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return [];
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            var at = DateTimeOffset.FromUnixTimeSeconds(doc.RootElement.GetProperty("at").GetInt64());
            if (now - at > TimeSpan.FromSeconds(Math.Max(60, SampleSeconds * 4))) return [];
            return doc.RootElement.GetProperty("services").EnumerateArray()
                .Select(s => new ServiceUsageDto(
                    s.GetProperty("name").GetString() ?? "?",
                    Round(s.GetProperty("cpuPercent").GetDouble()),
                    Round(s.GetProperty("memoryMb").GetDouble()),
                    s.TryGetProperty("memoryLimitMb", out var l) && l.ValueKind == JsonValueKind.Number ? Round(l.GetDouble()) : null))
                .OrderByDescending(s => s.MemoryMb)
                .ToList();
        }
        catch (Exception e) when (e is IOException or JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
        {
            return [];
        }
    }

    /// <summary>Runs `docker stats` in the background (it takes a couple of seconds); the next sample uses the result.</summary>
    private void RefreshDockerStats(string prefix)
    {
        if (Interlocked.Exchange(ref _dockerBusy, 1) == 1) return;
        _ = Task.Run(async () =>
        {
            try
            {
                // Docker reports the whole VM's memory as the "limit" of a container without one.
                _dockerVmMb ??= double.TryParse(await DockerAsync(["info", "--format", "{{.MemTotal}}"]), out var vm) ? vm / 1048576 : 0;
                var output = await DockerAsync(["stats", "--no-stream", "--format", "{{json .}}"]);
                var list = new List<ServiceUsageDto>();
                foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                {
                    using var doc = JsonDocument.Parse(line);
                    var name = doc.RootElement.GetProperty("Name").GetString() ?? "";
                    if (!name.StartsWith(prefix, StringComparison.Ordinal)) continue;
                    name = name[prefix.Length..];
                    if (name.EndsWith("-1", StringComparison.Ordinal)) name = name[..^2];
                    var cpu = ParsePercent(doc.RootElement.GetProperty("CPUPerc").GetString()) / Environment.ProcessorCount;
                    var mem = (doc.RootElement.GetProperty("MemUsage").GetString() ?? "").Split('/', StringSplitOptions.TrimEntries);
                    var limit = mem.Length > 1 ? ParseSize(mem[1]) : null;
                    if (limit is { } l && _dockerVmMb > 0 && Math.Abs(l - _dockerVmMb.Value) < _dockerVmMb * 0.01) limit = null;
                    list.Add(new ServiceUsageDto(name, Round(cpu), Round(ParseSize(mem[0]) ?? 0), limit is { } x ? Round(x) : null));
                }
                lock (_gate) _docker = list;
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                log.LogDebug(e, "docker stats failed");
                lock (_gate) _docker = [];
            }
            finally
            {
                Volatile.Write(ref _dockerBusy, 0);
            }
        });
    }

    private static async Task<string> DockerAsync(string[] args)
    {
        var psi = new ProcessStartInfo("docker", args)
        {
            RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true,
        };
        using var p = Process.Start(psi) ?? throw new InvalidOperationException("docker did not start");
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var output = await p.StandardOutput.ReadToEndAsync(cts.Token);
        await p.WaitForExitAsync(cts.Token);
        return output.Trim();
    }

    public static double ParsePercent(string? text) =>
        double.TryParse((text ?? "").TrimEnd('%'), System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : 0;

    /// <summary>"53.73MiB" / "1.2GiB" / "512kB" → MB.</summary>
    public static double? ParseSize(string text)
    {
        var units = new (string Suffix, double Mb)[] { ("KiB", 1 / 1024.0), ("MiB", 1), ("GiB", 1024), ("TiB", 1048576), ("kB", 1 / 1048.576), ("MB", 1 / 1.048576), ("GB", 1000 / 1.048576), ("B", 1 / 1048576.0) };
        foreach (var (suffix, mb) in units)
        {
            if (!text.EndsWith(suffix, StringComparison.Ordinal)) continue;
            return double.TryParse(text[..^suffix.Length], System.Globalization.CultureInfo.InvariantCulture, out var v) ? v * mb : null;
        }
        return null;
    }

    public (ResourcePointDto? Last, IReadOnlyList<ServiceUsageDto> Services, double? HostMemTotal, (double Mb, DateTimeOffset At)? Files,
        IReadOnlyList<ResourcePointDto> History) Read()
    {
        Interlocked.Exchange(ref _viewedTicks, DateTimeOffset.UtcNow.UtcTicks);
        lock (_gate) return (_last, _services, _hostMemTotal, _files, _history.ToList());
    }

    public DateTimeOffset Started => _started;

    private static double DirectoryMb(string root)
    {
        if (!Directory.Exists(root)) return 0;
        long bytes = 0;
        var opts = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint };
        foreach (var f in new DirectoryInfo(root).EnumerateFiles("*", opts))
        {
            try { bytes += f.Length; } catch (IOException) { }
        }
        return Round(bytes / 1048576.0);
    }

    internal static double Round(double v) => Math.Round(v, 1);
}

/// <summary>Whole-machine CPU and memory: /proc on Linux (inside a container this is still the host), Win32 on Windows.</summary>
public static partial class HostStats
{
    public static (ulong Busy, ulong Total)? CpuTimes()
    {
        try
        {
            if (OperatingSystem.IsLinux()) return ParseProcStat(File.ReadAllText("/proc/stat"));
            if (OperatingSystem.IsWindows() && GetSystemTimes(out var idle, out var kernel, out var user))
            {
                // Kernel time includes idle time.
                var total = (ulong)(kernel + user);
                return (total - (ulong)idle, total);
            }
        }
        catch (IOException) { }
        return null;
    }

    public static (double TotalMb, double AvailableMb)? Memory()
    {
        try
        {
            if (OperatingSystem.IsLinux()) return ParseMeminfo(File.ReadAllText("/proc/meminfo"));
            if (OperatingSystem.IsWindows())
            {
                var s = new MemoryStatusEx { Length = (uint)Marshal.SizeOf<MemoryStatusEx>() };
                if (GlobalMemoryStatusEx(ref s)) return (s.TotalPhys / 1048576.0, s.AvailPhys / 1048576.0);
            }
        }
        catch (IOException) { }
        return null;
    }

    public static (ulong Busy, ulong Total)? ParseProcStat(string text)
    {
        var line = text.Split('\n', 2)[0];
        if (!line.StartsWith("cpu ", StringComparison.Ordinal)) return null;
        var v = line[4..].Split(' ', StringSplitOptions.RemoveEmptyEntries).Select(ulong.Parse).ToArray();
        if (v.Length < 4) return null;
        // user nice system idle iowait irq softirq steal (guest time is already inside user/nice).
        var total = v.Take(8).Aggregate(0UL, (a, b) => a + b);
        var idle = v[3] + (v.Length > 4 ? v[4] : 0);
        return (total - idle, total);
    }

    public static (double TotalMb, double AvailableMb)? ParseMeminfo(string text)
    {
        double? total = null, avail = null;
        foreach (var line in text.Split('\n'))
        {
            var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 2 || !double.TryParse(parts[1], System.Globalization.CultureInfo.InvariantCulture, out var kb)) continue;
            if (parts[0] == "MemTotal:") total = kb / 1024;
            else if (parts[0] == "MemAvailable:") avail = kb / 1024;
        }
        return total is { } t && avail is { } a ? (t, a) : null;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatusEx
    {
        public uint Length;
        public uint MemoryLoad;
        public ulong TotalPhys;
        public ulong AvailPhys;
        public ulong TotalPageFile;
        public ulong AvailPageFile;
        public ulong TotalVirtual;
        public ulong AvailVirtual;
        public ulong AvailExtendedVirtual;
    }

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetSystemTimes(out long idle, out long kernel, out long user);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GlobalMemoryStatusEx(ref MemoryStatusEx buffer);
}

/// <summary>Builds the System page: samples plus database size, disk and live usage, for administrators only.</summary>
public sealed class SystemStatusService(
    ResourceSampler sampler, HangarDbContext db, PermissionService permissions, ConnectionRegistry registry, IOptions<StorageOptions> storage)
{
    public async Task<SystemSnapshotDto> GetAsync(Guid actor, Guid serverId, CancellationToken ct)
    {
        await permissions.RequireServerAsync(actor, serverId, Permission.Administrator, ct);
        var (last, services, hostMemTotal, files, history) = sampler.Read();
        using var proc = Process.GetCurrentProcess();
        var api = new ApiProcessDto(last?.ApiCpu ?? 0, ResourceSampler.Round(proc.WorkingSet64 / 1048576.0),
            ResourceSampler.Round(GC.GetTotalMemory(false) / 1048576.0), proc.Threads.Count,
            Math.Round((DateTimeOffset.UtcNow - sampler.Started).TotalSeconds), RuntimeInformation.FrameworkDescription);
        var host = new HostDto(RuntimeInformation.OSDescription, Environment.ProcessorCount, last?.HostCpu,
            hostMemTotal is { } t ? ResourceSampler.Round(t) : null, last?.HostMemoryUsedMb);

        DiskDto? disk = null;
        try
        {
            var root = Path.GetFullPath(storage.Value.Root);
            var drive = new DriveInfo(Path.GetPathRoot(root)!);
            disk = new DiskDto(root, Math.Round(drive.TotalSize / 1073741824.0, 1), Math.Round(drive.AvailableFreeSpace / 1073741824.0, 1),
                files?.Mb, files?.At);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException) { }

        var connections = registry.All();
        var inVoice = await db.VoiceLeases.CountAsync(l => l.Status == VoiceLeaseStatus.Active, ct);
        var streams = await db.MediaPublicationReservations.Where(r => r.State == ReservationState.Active)
            .GroupBy(r => r.Kind).Select(g => new { g.Key, Count = g.Count() }).ToListAsync(ct);
        var live = new LiveDto(connections.Select(c => c.UserId).Distinct().Count(), connections.Count, inVoice,
            streams.FirstOrDefault(s => s.Key == PublicationKind.Screen)?.Count ?? 0, streams.FirstOrDefault(s => s.Key == PublicationKind.Camera)?.Count ?? 0);

        return new SystemSnapshotDto(last?.At ?? DateTimeOffset.UtcNow, sampler.SampleSeconds, services.Count > 0 ? "services" : "api",
            last?.ProjectCpu ?? 0, last?.ProjectMemoryMb ?? api.MemoryMb, api, host, services, disk, await DatabaseAsync(ct), live, history);
    }

    private async Task<DatabaseDto?> DatabaseAsync(CancellationToken ct)
    {
        if (!db.Database.IsNpgsql()) return null;
        var conn = db.Database.GetDbConnection();
        var opened = conn.State != System.Data.ConnectionState.Open;
        if (opened) await conn.OpenAsync(ct);
        try
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = """
                SELECT pg_database_size(current_database()), NULL::text
                UNION ALL
                (SELECT pg_total_relation_size(relid), relname::text FROM pg_catalog.pg_statio_user_tables
                 ORDER BY pg_total_relation_size(relid) DESC LIMIT 6)
                """;
            await using var r = await cmd.ExecuteReaderAsync(ct);
            double size = 0;
            var tables = new List<TableSizeDto>();
            while (await r.ReadAsync(ct))
            {
                var mb = ResourceSampler.Round(r.GetInt64(0) / 1048576.0);
                if (r.IsDBNull(1)) size = mb;
                else tables.Add(new TableSizeDto(r.GetString(1), mb));
            }
            return new DatabaseDto(size, tables);
        }
        finally
        {
            if (opened) await conn.CloseAsync();
        }
    }
}
