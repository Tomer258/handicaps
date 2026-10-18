using Hangar.Core.Audit;
using Hangar.Core.Channels;
using Hangar.Core.Files;
using Hangar.Core.Identity;
using Hangar.Core.Media;
using Hangar.Core.Messaging;
using Hangar.Core.Permissions;
using Hangar.Core.Persistence;
using Hangar.Core.Soundboard;
using Hangar.Core.Users;
using Hangar.Core.Workspaces;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Hangar.Core;

public static class CoreServices
{
    public static IServiceCollection AddHangarCore(this IServiceCollection services, string connectionString)
    {
        services.AddDbContext<HangarDbContext>(o => o
            .UseNpgsql(connectionString, npg => npg.MigrationsHistoryTable("__ef_migrations_history"))
            .UseSnakeCaseNamingConvention());

        services.AddSingleton(TimeProvider.System);
        services.AddSingleton<IPasswordHasher<User>, PasswordHasher<User>>();
        services.AddSingleton<LoginThrottle>();

        services.AddScoped<AuditService>();
        services.AddScoped<PermissionService>();
        services.AddScoped<SessionRevocationNotifier>();
        services.AddScoped<AuthService>();
        services.AddScoped<InvitationService>();
        services.AddScoped<WorkspaceBootstrapper>();
        services.AddScoped<WorkspaceService>();
        services.AddScoped<ChannelService>();
        services.AddScoped<UserService>();
        services.AddScoped<MessageService>();
        services.AddScoped<RetentionService>();
        services.AddSingleton<VoiceStateCache>();
        services.AddScoped<VoiceService>();
        services.AddScoped<ISessionRevocationListener, VoiceRevocationListener>();
        services.AddSingleton<LocalFileStore>();
        services.AddScoped<SoundboardService>();
        services.AddScoped<SoundPlaybackService>();
        return services;
    }
}
