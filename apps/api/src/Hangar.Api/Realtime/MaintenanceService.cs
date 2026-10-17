using Hangar.Core.Audit;

namespace Hangar.Api.Realtime;

/// <summary>Hourly retention sweep. Failures are logged and retried next hour; nothing user-facing depends on it.</summary>
public sealed class MaintenanceService(IServiceScopeFactory scopes, ILogger<MaintenanceService> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Delay(TimeSpan.FromMinutes(1), stoppingToken);
        using var timer = new PeriodicTimer(TimeSpan.FromHours(1));
        do
        {
            try
            {
                using var scope = scopes.CreateScope();
                var removed = await scope.ServiceProvider.GetRequiredService<RetentionService>().RunAsync(stoppingToken);
                if (removed > 0) log.LogInformation("Retention removed {Count} rows", removed);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogWarning(ex, "Retention sweep failed");
            }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
