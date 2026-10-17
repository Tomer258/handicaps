using Hangar.Core.Media;
using Hangar.Core.Permissions;
using Hangar.Core.Persistence;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Hangar.Api.Realtime;

/// <summary>Pushes voice roster changes to connections whose user can currently see the voice channel.</summary>
public sealed class SignalRVoiceSink(
    IHubContext<HangarHub> hub, ConnectionRegistry registry, HangarDbContext db, PermissionService permissions) : IVoiceEventSink
{
    public async Task VoiceStateChangedAsync(Guid serverId, Guid channelId, Guid userId, VoiceMemberDto? state, CancellationToken ct)
    {
        var channel = await db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == channelId, ct);
        if (channel is null) return;
        var targets = new List<string>();
        foreach (var group in registry.All().GroupBy(c => c.UserId))
        {
            var mask = await permissions.ChannelPermissionsAsync(group.Key, channel, ct);
            if (mask.HasFlag(Permission.ViewChannel)) targets.AddRange(group.Select(c => c.ConnectionId));
        }
        if (targets.Count > 0)
            await hub.Clients.Clients(targets).SendAsync("voiceStateChanged", new { serverId, channelId, userId, state }, ct);
    }
}

/// <summary>Periodic lease/LiveKit reconciliation: the enforcement path that does not depend on webhooks.</summary>
public sealed class VoiceReconciler(IServiceScopeFactory scopes, IOptions<LiveKitOptions> options, ILogger<VoiceReconciler> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
        using var timer = new PeriodicTimer(options.Value.ReconcileInterval);
        do
        {
            try
            {
                using var scope = scopes.CreateScope();
                await scope.ServiceProvider.GetRequiredService<VoiceService>().ReconcileAsync(stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogWarning(ex, "Voice reconciliation failed");
            }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
