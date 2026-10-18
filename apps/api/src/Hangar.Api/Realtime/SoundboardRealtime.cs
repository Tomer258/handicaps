using Hangar.Core.Permissions;
using Hangar.Core.Persistence;
using Hangar.Core.Soundboard;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Hangar.Api.Realtime;

/// <summary>Catalog changes go to server members (clients refetch); playback state goes to users who can see the channel.</summary>
public sealed class SignalRSoundSink(
    IHubContext<HangarHub> hub, ConnectionRegistry registry, HangarDbContext db, PermissionService permissions) : ISoundEventSink
{
    public async Task CatalogChangedAsync(Guid serverId, Guid soundId, CancellationToken ct)
    {
        var members = (await db.ServerMembers.AsNoTracking().Where(m => m.ServerId == serverId && m.RemovedAt == null)
            .Select(m => m.UserId).ToListAsync(ct)).ToHashSet();
        var targets = registry.All().Where(c => members.Contains(c.UserId)).Select(c => c.ConnectionId).ToList();
        if (targets.Count > 0) await hub.Clients.Clients(targets).SendAsync("soundCatalogChanged", new { serverId, soundId }, ct);
    }

    public async Task PlaybackChangedAsync(SoundPlaybackDto playback, CancellationToken ct)
    {
        var channel = await db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == playback.ChannelId, ct);
        if (channel is null) return;
        var targets = new List<string>();
        foreach (var group in registry.All().GroupBy(c => c.UserId))
        {
            var mask = await permissions.ChannelPermissionsAsync(group.Key, channel, ct);
            if (mask.HasFlag(Permission.ViewChannel)) targets.AddRange(group.Select(c => c.ConnectionId));
        }
        if (targets.Count > 0) await hub.Clients.Clients(targets).SendAsync("soundPlaybackChanged", playback, ct);
    }
}

/// <summary>Collects validator results (sounds and images) and reconciles playback once a second (cheap indexed queries).</summary>
public sealed class SoundboardLoop(IServiceScopeFactory scopes, ILogger<SoundboardLoop> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                using var scope = scopes.CreateScope();
                await scope.ServiceProvider.GetRequiredService<Hangar.Core.Files.ValidationCollector>().CollectAsync(stoppingToken);
                await scope.ServiceProvider.GetRequiredService<SoundPlaybackService>().ReconcileAsync(stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogWarning(ex, "Soundboard loop failed");
            }
        }
    }
}
