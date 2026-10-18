using System.Net;
using System.Net.Http.Json;
using Hangar.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Hangar.Tests.Integration.Scenario;

namespace Hangar.Tests.Integration;

/// <summary>S9a: role CRUD and the role hierarchy (manage only below your top role, grant only what you hold).</summary>
[Collection("api")]
public class RoleTests(ApiFactory factory)
{
    private const long View = 1L << 0;
    private const long ManageRoles = 1L << 18;
    private const long Administrator = 1L << 21;

    private static async Task<Guid> CreateRoleAsync(TestClient c, Guid serverId, string name, long permissions = 0)
    {
        var r = await c.Http.PostAsJsonAsync($"/api/v1/servers/{serverId}/roles", new { name, permissions });
        r.EnsureSuccessStatusCode();
        return (await Json(r)).GetProperty("id").GetGuid();
    }

    private static Task<HttpResponseMessage> SetRolesAsync(TestClient c, Guid serverId, Guid userId, params Guid[] roleIds) =>
        c.Http.PutAsJsonAsync($"/api/v1/servers/{serverId}/members/{userId}/roles", new { roleIds });

    private async Task<Dictionary<Guid, int>> PositionsAsync(params Guid[] ids)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HangarDbContext>();
        return await db.Roles.Where(r => ids.Contains(r.Id)).ToDictionaryAsync(r => r.Id, r => r.Position);
    }

    [Fact]
    public async Task Manager_is_limited_to_roles_and_members_below_them_and_bits_they_hold()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var low = await CreateRoleAsync(owner, serverId, "low");
        var mgr = await CreateRoleAsync(owner, serverId, "mgr", View | ManageRoles);
        var (a, aId) = await MemberAsync(factory, owner, serverId, "mgr");
        var (_, bId) = await MemberAsync(factory, owner, serverId, "peer");
        Assert.Equal(HttpStatusCode.NoContent, (await SetRolesAsync(owner, serverId, aId, mgr)).StatusCode);

        // Creating: cannot grant Administrator; a role with held bits lands just below the creator's top role.
        Assert.Equal(HttpStatusCode.Forbidden,
            (await a.Http.PostAsJsonAsync($"/api/v1/servers/{serverId}/roles", new { name = "x", permissions = Administrator })).StatusCode);
        var made = await CreateRoleAsync(a, serverId, "made", ManageRoles);
        var pos = await PositionsAsync(made, mgr, low);
        Assert.True(pos[made] < pos[mgr] && pos[made] > pos[low]);

        // Editing: own top role is off limits; lower roles may get held bits but not others.
        Assert.Equal(HttpStatusCode.Forbidden,
            (await a.Http.PatchAsJsonAsync($"/api/v1/servers/{serverId}/roles/{mgr}", new { name = "boss" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden,
            (await a.Http.PatchAsJsonAsync($"/api/v1/servers/{serverId}/roles/{low}", new { permissions = Administrator })).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent,
            (await a.Http.PatchAsJsonAsync($"/api/v1/servers/{serverId}/roles/{low}", new { permissions = View | ManageRoles })).StatusCode);

        // Assigning: lower roles yes, own top role no; a peer at the same level cannot be edited at all.
        Assert.Equal(HttpStatusCode.Forbidden, (await SetRolesAsync(a, serverId, bId, mgr)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await SetRolesAsync(a, serverId, bId, low)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await SetRolesAsync(owner, serverId, bId, mgr)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await SetRolesAsync(a, serverId, bId)).StatusCode);

        // Channel overrides follow the same rules.
        var ch = await NewTextChannelAsync(owner, serverId);
        Assert.Equal(HttpStatusCode.Forbidden,
            (await a.Http.PutAsJsonAsync($"/api/v1/channels/{ch}/overrides", new { roleId = mgr, allow = 0, deny = View })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden,
            (await a.Http.PutAsJsonAsync($"/api/v1/channels/{ch}/overrides", new { roleId = low, allow = Administrator, deny = 0 })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden,
            (await a.Http.PutAsJsonAsync($"/api/v1/channels/{ch}/overrides", new { memberUserId = bId, allow = 0, deny = View })).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent,
            (await a.Http.PutAsJsonAsync($"/api/v1/channels/{ch}/overrides", new { roleId = low, allow = 0, deny = View })).StatusCode);

        // Only members with Administrator may remove members.
        Assert.Equal(HttpStatusCode.Forbidden, (await a.Http.DeleteAsync($"/api/v1/servers/{serverId}/members/{bId}")).StatusCode);

        foreach (var id in new[] { made, mgr, low })
            Assert.Equal(HttpStatusCode.NoContent, (await owner.Http.DeleteAsync($"/api/v1/servers/{serverId}/roles/{id}")).StatusCode);
    }

    [Fact]
    public async Task Owner_reorders_and_deletes_roles_and_delete_cleans_up()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var r1 = await CreateRoleAsync(owner, serverId, "r1");
        var r2 = await CreateRoleAsync(owner, serverId, "r2");
        var before = await PositionsAsync(r1, r2);
        Assert.True(before[r2] > before[r1]);

        Assert.Equal(HttpStatusCode.NoContent,
            (await owner.Http.PutAsJsonAsync($"/api/v1/servers/{serverId}/roles/order", new { roleIds = new[] { r1, r2 } })).StatusCode);
        var after = await PositionsAsync(r1, r2);
        Assert.Equal(before[r2], after[r1]);
        Assert.Equal(before[r1], after[r2]);

        var (_, mId) = await MemberAsync(factory, owner, serverId);
        Assert.Equal(HttpStatusCode.NoContent, (await SetRolesAsync(owner, serverId, mId, r1)).StatusCode);
        var ch = await NewTextChannelAsync(owner, serverId);
        Assert.Equal(HttpStatusCode.NoContent,
            (await owner.Http.PutAsJsonAsync($"/api/v1/channels/{ch}/overrides", new { roleId = r1, allow = 0, deny = View })).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await owner.Http.DeleteAsync($"/api/v1/servers/{serverId}/roles/{r1}")).StatusCode);
        Assert.Equal(0, (await Json(await owner.Http.GetAsync($"/api/v1/channels/{ch}/overrides"))).GetArrayLength());
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HangarDbContext>();
            Assert.False(await db.MemberRoles.AnyAsync(x => x.RoleId == r1));
        }

        var everyone = await DefaultRoleAsync();
        Assert.Equal(HttpStatusCode.Conflict, (await owner.Http.DeleteAsync($"/api/v1/servers/{serverId}/roles/{everyone}")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Http.DeleteAsync($"/api/v1/servers/{serverId}/roles/{r2}")).StatusCode);
    }

    private async Task<Guid> DefaultRoleAsync()
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HangarDbContext>();
        return await db.Roles.Where(r => r.IsDefault).Select(r => r.Id).FirstAsync();
    }
}
