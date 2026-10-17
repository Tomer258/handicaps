using Hangar.Core.Media;
using System.Text.Json.Serialization;
using System.Threading.RateLimiting;
using Hangar.Api.Endpoints;
using Hangar.Api.Infrastructure;
using Hangar.Api.Realtime;
using Hangar.Core;
using Hangar.Core.Identity;
using Hangar.Core.Persistence;
using Hangar.Core.Users;
using Hangar.Core.Workspaces;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

var builder = WebApplication.CreateBuilder(args);
var config = builder.Configuration;

builder.Services.Configure<HangarOptions>(config.GetSection("Hangar"));
builder.Services.Configure<WorkspaceBootstrapOptions>(config.GetSection("Hangar:Bootstrap"));
builder.Services.PostConfigure<WorkspaceBootstrapOptions>(o => o.PublicBaseUrl = config["Hangar:PublicBaseUrl"] ?? o.PublicBaseUrl);
builder.Services.Configure<HangarIdentityOptions>(config.GetSection("Hangar:Identity"));
builder.Services.Configure<LiveKitOptions>(config.GetSection("Hangar:LiveKit"));

var hangar = config.GetSection("Hangar").Get<HangarOptions>() ?? new HangarOptions();
var dataDir = Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, hangar.DataDirectory));
Directory.CreateDirectory(dataDir);

builder.Services.AddHangarCore(config.GetConnectionString("Hangar")
                               ?? throw new InvalidOperationException("ConnectionStrings:Hangar is required."));
// Realtime (SignalR): registry, outbox dispatcher, presence, revocation.
builder.Services.AddSingleton<ConnectionRegistry>();
builder.Services.AddSingleton<OutboxSignal>();
builder.Services.AddSingleton<Hangar.Core.Messaging.IOutboxSignal>(sp => sp.GetRequiredService<OutboxSignal>());
builder.Services.AddSingleton<PresenceBroadcaster>();
builder.Services.AddScoped<IPolicyChangeSink, SignalRPolicySink>();
builder.Services.AddScoped<IProfileChangeSink, SignalRProfileSink>();
builder.Services.AddScoped<ISessionRevocationListener, RealtimeRevocationListener>();
builder.Services.AddHostedService<OutboxDispatcher>();
builder.Services.AddHostedService<PresenceSweeper>();
builder.Services.AddHostedService<MaintenanceService>();
// Media: LiveKit RoomService adapter (private network), voice roster push, reconciliation.
builder.Services.AddHttpClient<ILiveKitRooms, LiveKitRoomClient>(c => c.Timeout = TimeSpan.FromSeconds(5));
builder.Services.AddScoped<IVoiceEventSink, SignalRVoiceSink>();
builder.Services.AddHostedService<VoiceReconciler>();
builder.Services.AddSignalR(o =>
{
    o.AddFilter<SessionHubFilter>();
    o.MaximumReceiveMessageSize = 32 * 1024;
    o.KeepAliveInterval = TimeSpan.FromSeconds(15);
    o.ClientTimeoutInterval = TimeSpan.FromSeconds(45);
}).AddJsonProtocol(o => o.PayloadSerializerOptions.Converters.Add(new JsonStringEnumConverter(System.Text.Json.JsonNamingPolicy.CamelCase)));
builder.Services.AddSingleton<SessionHubFilter>();

builder.Services.AddHangarProblems();
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.Converters.Add(new JsonStringEnumConverter(System.Text.Json.JsonNamingPolicy.CamelCase));
    o.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.Never;
});

// Data Protection keys must persist across restarts/deploys or every session cookie becomes unreadable.
builder.Services.AddDataProtection()
    .SetApplicationName("hangar")
    .PersistKeysToFileSystem(new DirectoryInfo(Path.Combine(dataDir, "keys")));

builder.Services.AddAntiforgery(o =>
{
    o.HeaderName = HangarOptions.XsrfHeaderName;
    o.Cookie.Name = hangar.AntiforgeryCookieName;
    o.Cookie.HttpOnly = true;
    o.Cookie.SameSite = SameSiteMode.Strict;
    o.Cookie.SecurePolicy = hangar.SecureCookies ? CookieSecurePolicy.Always : CookieSecurePolicy.SameAsRequest;
    o.Cookie.Path = "/";
});

builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(o =>
    {
        o.Cookie.Name = hangar.CookieName;
        o.Cookie.HttpOnly = true;
        o.Cookie.SameSite = SameSiteMode.Lax;
        o.Cookie.SecurePolicy = hangar.SecureCookies ? CookieSecurePolicy.Always : CookieSecurePolicy.SameAsRequest;
        o.Cookie.Path = "/";
        o.SlidingExpiration = false; // PostgreSQL UserSession owns idle/absolute expiry.
        o.ExpireTimeSpan = TimeSpan.FromDays(30);
        o.Events = new CookieAuthenticationEvents
        {
            OnRedirectToLogin = ctx => { ctx.Response.StatusCode = 401; return Task.CompletedTask; },
            OnRedirectToAccessDenied = ctx => { ctx.Response.StatusCode = 403; return Task.CompletedTask; },
            // Authoritative revocation: validate the session row on every authenticated request.
            OnValidatePrincipal = async ctx =>
            {
                var p = ctx.Principal;
                var ok = p is not null
                         && Guid.TryParse(p.FindFirst(HangarClaims.UserId)?.Value, out var uid)
                         && Guid.TryParse(p.FindFirst(HangarClaims.SessionId)?.Value, out var sid)
                         && await ctx.HttpContext.RequestServices.GetRequiredService<AuthService>()
                             .ValidateSessionAsync(sid, uid, ctx.HttpContext.RequestAborted);
                if (!ok)
                {
                    ctx.RejectPrincipal();
                    await ctx.HttpContext.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
                }
            },
        };
    });
builder.Services.AddAuthorizationBuilder()
    .SetFallbackPolicy(new Microsoft.AspNetCore.Authorization.AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());

builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = 429;
    o.AddPolicy("auth", http => RateLimitPartition.GetFixedWindowLimiter(
        http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = config.GetValue("Hangar:AuthRequestsPerMinute", 20), Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
});

builder.Services.Configure<ForwardedHeadersOptions>(o =>
{
    // Only the local reverse proxy (Caddy) is trusted; externally supplied forwarding headers are ignored otherwise.
    o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedHost;
    o.KnownIPNetworks.Clear();
    o.KnownProxies.Clear();
    foreach (var proxy in config.GetSection("Hangar:TrustedProxies").Get<string[]>() ?? [])
        o.KnownProxies.Add(System.Net.IPAddress.Parse(proxy));
});

builder.Services.AddOpenApi();

var app = builder.Build();

app.UseForwardedHeaders();
app.UseExceptionHandler();
app.UseStatusCodePages();
// WebSocket/negotiate requests are not covered by CORS: enforce the expected browser Origin explicitly.
app.Use(async (ctx, next) =>
{
    if (ctx.Request.Path.StartsWithSegments("/hubs"))
        OriginGuard.Ensure(ctx, ctx.RequestServices.GetRequiredService<IOptions<HangarOptions>>().Value);
    await next();
});
app.UseAuthentication();
app.UseAuthorization();
app.UseRateLimiter();

if (app.Environment.IsDevelopment())
    app.MapOpenApi("/api/openapi/{documentName}.json").AllowAnonymous();

app.MapGet("/healthz", async (HangarDbContext db, CancellationToken ct) =>
    await db.Database.CanConnectAsync(ct) ? Results.Ok(new { status = "ok" }) : Results.StatusCode(503)).AllowAnonymous();

var api = app.MapGroup("/api/v1").AddEndpointFilter<CsrfFilter>();
api.MapAuth();
api.MapWorkspaces();
api.MapMessages();
api.MapVoice();
app.MapLiveKitInternal();
app.MapHub<HangarHub>(HangarHub.Path);

await InitializeAsync(app);
app.Run();

static async Task InitializeAsync(WebApplication app)
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<HangarDbContext>();
    var migrate = app.Configuration.GetValue("Hangar:MigrateOnStartup", app.Environment.IsDevelopment());
    if (migrate) await db.Database.MigrateAsync();
    var opts = scope.ServiceProvider.GetRequiredService<IOptions<WorkspaceBootstrapOptions>>().Value;
    await scope.ServiceProvider.GetRequiredService<WorkspaceBootstrapper>().EnsureAsync(opts, CancellationToken.None);
}

public partial class Program;
