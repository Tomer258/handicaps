using System.Net.Http.Json;
using System.Text.Json;
using Hangar.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Hangar.Tests.Integration;

/// <summary>Shared setup helpers: an owner client, invited members, channel lookups.</summary>
public static class Scenario
{
    public static async Task<JsonElement> Json(HttpResponseMessage r) =>
        JsonDocument.Parse(await r.Content.ReadAsStringAsync()).RootElement;

    public static async Task<(TestClient Owner, Guid ServerId)> OwnerAsync(ApiFactory factory)
    {
        var owner = factory.NewClient();
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HangarDbContext>();
        var server = await db.Servers.FirstAsync();
        if (server.OwnerUserId is null)
            (await owner.RegisterAsync(await factory.OwnerBootstrapSecretAsync(), "owner")).EnsureSuccessStatusCode();
        else
            (await owner.LoginAsync("owner")).EnsureSuccessStatusCode();
        return (owner, server.Id);
    }

    public static async Task<string> InviteAsync(TestClient owner, Guid serverId, int maxUses = 1)
    {
        var r = await owner.Http.PostAsJsonAsync($"/api/v1/servers/{serverId}/invitations", new { maxUses });
        r.EnsureSuccessStatusCode();
        return (await Json(r)).GetProperty("secret").GetString()!;
    }

    public static async Task<(TestClient Client, Guid UserId)> MemberAsync(ApiFactory factory, TestClient owner, Guid serverId, string prefix = "m")
    {
        var c = factory.NewClient();
        var login = $"{prefix}{Guid.NewGuid():N}"[..20];
        var r = await c.RegisterAsync(await InviteAsync(owner, serverId), login, displayName: prefix);
        r.EnsureSuccessStatusCode();
        var id = (await Json(r)).GetProperty("user").GetProperty("id").GetGuid();
        return (c, id);
    }

    public static async Task<Guid> ChannelAsync(ApiFactory factory, string name)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HangarDbContext>();
        return await db.Channels.Where(c => c.Name == name).Select(c => c.Id).FirstAsync();
    }

    public static async Task<Guid> NewTextChannelAsync(TestClient owner, Guid serverId, string? name = null)
    {
        var r = await owner.Http.PostAsJsonAsync($"/api/v1/servers/{serverId}/channels", new { type = "text", name = name ?? $"t{Guid.NewGuid():N}"[..12] });
        r.EnsureSuccessStatusCode();
        return (await Json(r)).GetProperty("id").GetGuid();
    }

    public static Task<HttpResponseMessage> SendAsync(TestClient c, Guid channelId, string body, Guid? clientId = null, Guid? replyTo = null) =>
        c.Http.PostAsJsonAsync($"/api/v1/channels/{channelId}/messages", new { clientMessageId = clientId ?? Guid.NewGuid(), body, replyToId = replyTo });
}
