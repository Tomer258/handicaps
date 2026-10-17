using System.Net;
using System.Net.Http.Json;
using Hangar.Core.Media;
using Hangar.Core.Workspaces;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Testcontainers.PostgreSql;

namespace Hangar.Tests.Integration;

/// <summary>Real ASP.NET host against a real PostgreSQL 18 container (no in-memory database fakes).</summary>
public sealed class ApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly PostgreSqlContainer _pg = new PostgreSqlBuilder("postgres:18-alpine").Build();
    private readonly string _dataDir = Path.Combine(AppContext.BaseDirectory, "test-data", Guid.NewGuid().ToString("N"));

    public async Task InitializeAsync() => await _pg.StartAsync();

    public new async Task DisposeAsync()
    {
        await base.DisposeAsync();
        await _pg.DisposeAsync();
        try { Directory.Delete(_dataDir, true); } catch { /* best effort */ }
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Development");
        builder.UseSetting("ConnectionStrings:Hangar", _pg.GetConnectionString());
        builder.UseSetting("Hangar:DataDirectory", _dataDir);
        builder.UseSetting("Hangar:MigrateOnStartup", "true");
        builder.UseSetting("Hangar:AllowedOrigins:0", "http://localhost");
        builder.UseSetting("Hangar:AuthRequestsPerMinute", "10000");
        builder.UseSetting("Hangar:LiveKit:MaxHumans", MaxHumans.ToString());
        // Tests drive reconciliation explicitly; the background loop must not race them.
        builder.UseSetting("Hangar:LiveKit:ReconcileInterval", "01:00:00");
        builder.ConfigureTestServices(s => s.AddSingleton<ILiveKitRooms>(LiveKit));
    }

    public const int MaxHumans = 6;
    public FakeLiveKitRooms LiveKit { get; } = new();

    /// <summary>Re-issues the owner bootstrap invitation (only possible while no owner exists) and returns its secret.</summary>
    public async Task<string> OwnerBootstrapSecretAsync()
    {
        using var scope = Services.CreateScope();
        var link = await scope.ServiceProvider.GetRequiredService<WorkspaceBootstrapper>()
            .EnsureAsync(scope.ServiceProvider.GetRequiredService<IOptions<WorkspaceBootstrapOptions>>().Value, CancellationToken.None);
        return link!.Split("/invite/")[1];
    }

    public TestClient NewClient()
    {
        var handler = new BrowserLikeHandler();
        return new TestClient(CreateDefaultClient(new Uri("http://localhost"), handler), handler);
    }
}

/// <summary>Cookie jar + Angular-style XSRF header echo, like the real SPA.</summary>
public sealed class BrowserLikeHandler : DelegatingHandler
{
    public CookieContainer Cookies { get; } = new();
    public bool SendXsrf { get; set; } = true;
    public string? OriginOverride { get; set; }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var uri = request.RequestUri!;
        var header = Cookies.GetCookieHeader(uri);
        if (!string.IsNullOrEmpty(header)) request.Headers.Add("Cookie", header);
        if (SendXsrf && request.Method != HttpMethod.Get)
        {
            var xsrf = Cookies.GetCookies(uri)["XSRF-TOKEN"]?.Value;
            if (xsrf is not null) request.Headers.Add("X-XSRF-TOKEN", xsrf);
        }
        if (OriginOverride is not null) request.Headers.Add("Origin", OriginOverride);

        var response = await base.SendAsync(request, ct);
        if (response.Headers.TryGetValues("Set-Cookie", out var setCookies))
            foreach (var c in setCookies) Cookies.SetCookies(uri, c);
        return response;
    }
}

public sealed class TestClient(HttpClient http, BrowserLikeHandler handler)
{
    public HttpClient Http { get; } = http;
    public BrowserLikeHandler Handler { get; } = handler;

    public async Task CsrfAsync() => (await Http.GetAsync("/api/v1/auth/csrf")).EnsureSuccessStatusCode();

    public async Task<HttpResponseMessage> RegisterAsync(string secret, string login, string password = "correct horse battery", string? displayName = null)
    {
        await CsrfAsync();
        return await Http.PostAsJsonAsync("/api/v1/auth/register", new
        {
            inviteSecret = secret, login, password, displayName = displayName ?? login, remember = true,
        });
    }

    public async Task<HttpResponseMessage> LoginAsync(string login, string password = "correct horse battery")
    {
        await CsrfAsync();
        return await Http.PostAsJsonAsync("/api/v1/auth/login", new { login, password, remember = false });
    }
}
