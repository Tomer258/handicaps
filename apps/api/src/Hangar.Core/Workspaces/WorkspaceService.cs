using Hangar.Core.Audit;
using Hangar.Core.Channels;
using Hangar.Core.Common;
using Hangar.Core.Permissions;
using Hangar.Core.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Hangar.Core.Workspaces;

public sealed record ServerSummaryDto(Guid Id, string Name, bool IsOwner);

public sealed record ChannelDto(Guid Id, Guid ServerId, string Type, string Name, string? Topic, int Position, long Permissions, string LastMessageSequence);

public sealed record RoleDto(Guid Id, string Name, long Permissions, bool IsDefault, int Position, string? Color, bool Hoist);

public sealed record ServerDetailDto(Guid Id, string Name, Guid? OwnerUserId, long MyPermissions, string PolicyVersion,
    IReadOnlyList<ChannelDto> Channels, IReadOnlyList<RoleDto> Roles);

public sealed record MemberDto(Guid UserId, string Login, string DisplayName, int AvatarHue, Guid? AvatarAssetId,
    IReadOnlyList<Guid> RoleIds, bool IsOwner, DateTimeOffset JoinedAt, DateTimeOffset? LastOnlineAt, Guid? InvitedBy = null);

public sealed class WorkspaceService(HangarDbContext db, PermissionService permissions, AuditService audit, IPolicyChangeSink policySink)
{
    public async Task<List<ServerSummaryDto>> ListServersAsync(Guid userId, CancellationToken ct) =>
        await db.ServerMembers.AsNoTracking()
            .Where(m => m.UserId == userId && m.RemovedAt == null)
            .Join(db.Servers, m => m.ServerId, s => s.Id, (m, s) => s)
            .OrderBy(s => s.CreatedAt)
            .Select(s => new ServerSummaryDto(s.Id, s.Name, s.OwnerUserId == userId))
            .ToListAsync(ct);

    public async Task<ServerDetailDto> GetServerAsync(Guid userId, Guid serverId, CancellationToken ct)
    {
        var mine = await permissions.ServerPermissionsAsync(userId, serverId, ct);
        if (mine == Permission.None) throw AppProblem.NotFound("server.not_found", "Server not found.");

        var server = await db.Servers.AsNoTracking().FirstAsync(s => s.Id == serverId, ct);
        var visible = await permissions.VisibleChannelsAsync(userId, serverId, ct);
        var channels = await db.Channels.AsNoTracking()
            .Where(c => c.ServerId == serverId && c.ArchivedAt == null)
            .OrderBy(c => c.Position).ToListAsync(ct);
        var roles = await db.Roles.AsNoTracking().Where(r => r.ServerId == serverId).OrderByDescending(r => r.Position)
            .Select(r => new RoleDto(r.Id, r.Name, (long)r.PermissionMask, r.IsDefault, r.Position, r.Color, r.Hoist)).ToListAsync(ct);

        return new ServerDetailDto(server.Id, server.Name, server.OwnerUserId, (long)mine, server.PolicyVersion.ToString(),
            channels.Where(c => visible.ContainsKey(c.Id)).Select(c => ToDto(c, visible[c.Id])).ToList(), roles);
    }

    public async Task<List<MemberDto>> ListMembersAsync(Guid userId, Guid serverId, CancellationToken ct)
    {
        await permissions.RequireServerAsync(userId, serverId, Permission.None, ct);
        var ownerId = await db.Servers.Where(s => s.Id == serverId).Select(s => s.OwnerUserId).FirstAsync(ct);
        var rows = await db.ServerMembers.AsNoTracking()
            .Where(m => m.ServerId == serverId && m.RemovedAt == null)
            .Join(db.Users, m => m.UserId, u => u.Id, (m, u) => new { m, u })
            .Where(x => x.u.DisabledAt == null)
            .Take(500)
            .ToListAsync(ct);
        var roleRows = await db.MemberRoles.AsNoTracking().Where(r => r.ServerId == serverId).ToListAsync(ct);
        var byUser = roleRows.GroupBy(r => r.UserId).ToDictionary(g => g.Key, g => (IReadOnlyList<Guid>)g.Select(x => x.RoleId).ToList());

        return rows.Select(x => new MemberDto(x.u.Id, x.u.Login, x.u.DisplayName, x.u.AvatarHue, x.u.AvatarAssetId,
                byUser.GetValueOrDefault(x.u.Id) ?? [], x.u.Id == ownerId, x.m.JoinedAt, x.u.LastOnlineAt, x.m.InvitedBy))
            .OrderBy(m => m.DisplayName, StringComparer.OrdinalIgnoreCase).ToList();
    }

    public async Task SetMemberRolesAsync(Guid actor, Guid serverId, Guid targetUserId, IReadOnlyCollection<Guid> roleIds, CancellationToken ct)
    {
        var auth = await permissions.RequireAuthorityAsync(actor, serverId, Permission.ManageRoles, ct);
        if (roleIds.Count > 20) throw AppProblem.BadRequest("validation.roles", "Too many roles.");
        if (!await db.ServerMembers.AnyAsync(m => m.ServerId == serverId && m.UserId == targetUserId && m.RemovedAt == null, ct))
            throw AppProblem.NotFound("member.not_found", "Member not found.");
        var server = await db.Servers.FirstAsync(s => s.Id == serverId, ct);
        if (!auth.CanManageMember(server.OwnerUserId == targetUserId, await permissions.TopPositionAsync(targetUserId, serverId, ct), targetUserId))
            throw AppProblem.Forbidden("member.hierarchy", "You can only manage members below your highest role.");

        var roles = await db.Roles.Where(r => r.ServerId == serverId && !r.IsDefault).ToDictionaryAsync(r => r.Id, ct);
        if (roleIds.Distinct().Any(id => !roles.ContainsKey(id))) throw AppProblem.BadRequest("validation.roles", "Unknown role.");
        var current = await db.MemberRoles.Where(r => r.ServerId == serverId && r.UserId == targetUserId).Select(r => r.RoleId).ToListAsync(ct);
        var wanted = roleIds.Distinct().ToList();
        // Only roles that actually change hands are checked, so a manager can edit someone who also holds a higher role.
        foreach (var changed in wanted.Except(current).Concat(current.Except(wanted))) auth.RequireRole(roles[changed].Position);

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await db.MemberRoles.Where(r => r.ServerId == serverId && r.UserId == targetUserId).ExecuteDeleteAsync(ct);
        db.MemberRoles.AddRange(wanted.Select(id => new MemberRole { ServerId = serverId, UserId = targetUserId, RoleId = id }));
        server.PolicyVersion++;
        audit.Record(actor, "member", targetUserId.ToString(), "member.roles_set", detail: string.Join(',', wanted));
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        await policySink.PolicyChangedAsync(serverId, server.PolicyVersion, [targetUserId], ct);
    }

    public async Task<RoleDto> CreateRoleAsync(Guid actor, Guid serverId, string name, string? color, long permissionsMask, bool hoist, CancellationToken ct)
    {
        var auth = await permissions.RequireAuthorityAsync(actor, serverId, Permission.ManageRoles, ct);
        var mask = (Permission)permissionsMask & Permission.All;
        auth.RequireGrant(Permission.None, mask);
        var roles = await db.Roles.Where(r => r.ServerId == serverId).ToListAsync(ct);
        if (roles.Count >= 50) throw AppProblem.Conflict("role.limit", "A server can have at most 50 roles.");

        // New roles go right below the creator's highest role (the owner: on top), shifting the rest up.
        var position = auth.IsOwner ? roles.Max(r => r.Position) + 1 : Math.Max(1, auth.TopPosition);
        foreach (var r in roles.Where(r => !r.IsDefault && r.Position >= position)) r.Position++;
        var role = new Role
        {
            Id = Guid.CreateVersion7(), ServerId = serverId, Name = Guard.Text(name, "name", 1, 32), PermissionMask = mask,
            Position = position, Color = Guard.OptionalText(color, "color", 16), Hoist = hoist,
        };
        db.Roles.Add(role);
        var server = await db.Servers.FirstAsync(s => s.Id == serverId, ct);
        server.PolicyVersion++;
        audit.Record(actor, "role", role.Id.ToString(), "role.create", detail: $"mask={(long)mask}");
        await db.SaveChangesAsync(ct);
        await policySink.PolicyChangedAsync(serverId, server.PolicyVersion, null, ct);
        return new RoleDto(role.Id, role.Name, (long)role.PermissionMask, false, role.Position, role.Color, role.Hoist);
    }

    public async Task UpdateRoleAsync(Guid actor, Guid serverId, Guid roleId, string? name, long? permissionsMask, string? color, bool? hoist, CancellationToken ct)
    {
        var auth = await permissions.RequireAuthorityAsync(actor, serverId, Permission.ManageRoles, ct);
        var role = await db.Roles.FirstOrDefaultAsync(r => r.Id == roleId && r.ServerId == serverId, ct)
                   ?? throw AppProblem.NotFound("role.not_found", "Role not found.");
        auth.RequireRole(role.Position);
        if (name is not null && !role.IsDefault) role.Name = Guard.Text(name, "name", 1, 32);
        if (permissionsMask is not null)
        {
            var next = (Permission)permissionsMask.Value & Permission.All;
            auth.RequireGrant(role.PermissionMask, next);
            role.PermissionMask = next;
        }
        if (color is not null) role.Color = Guard.OptionalText(color, "color", 16);
        if (hoist is not null && !role.IsDefault) role.Hoist = hoist.Value;
        var server = await db.Servers.FirstAsync(s => s.Id == serverId, ct);
        server.PolicyVersion++;
        audit.Record(actor, "role", roleId.ToString(), "role.update", detail: $"mask={(long)role.PermissionMask}");
        await db.SaveChangesAsync(ct);
        await policySink.PolicyChangedAsync(serverId, server.PolicyVersion, null, ct);
    }

    public async Task DeleteRoleAsync(Guid actor, Guid serverId, Guid roleId, CancellationToken ct)
    {
        var auth = await permissions.RequireAuthorityAsync(actor, serverId, Permission.ManageRoles, ct);
        var role = await db.Roles.FirstOrDefaultAsync(r => r.Id == roleId && r.ServerId == serverId, ct)
                   ?? throw AppProblem.NotFound("role.not_found", "Role not found.");
        if (role.IsDefault) throw AppProblem.Conflict("role.default", "The @everyone role cannot be deleted.");
        auth.RequireRole(role.Position);

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await db.MemberRoles.Where(r => r.RoleId == roleId).ExecuteDeleteAsync(ct);
        await db.ChannelPermissions.Where(o => o.RoleId == roleId).ExecuteDeleteAsync(ct);
        db.Roles.Remove(role);
        var server = await db.Servers.FirstAsync(s => s.Id == serverId, ct);
        server.PolicyVersion++;
        audit.Record(actor, "role", roleId.ToString(), "role.delete", detail: role.Name);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        await policySink.PolicyChangedAsync(serverId, server.PolicyVersion, null, ct);
    }

    /// <summary>
    /// Reorders roles the caller may manage, highest first. Those roles keep the same set of positions, so roles the
    /// caller cannot manage (including their own top role) never move.
    /// </summary>
    public async Task ReorderRolesAsync(Guid actor, Guid serverId, IReadOnlyList<Guid> roleIdsHighestFirst, CancellationToken ct)
    {
        var auth = await permissions.RequireAuthorityAsync(actor, serverId, Permission.ManageRoles, ct);
        if (roleIdsHighestFirst.Count == 0 || roleIdsHighestFirst.Distinct().Count() != roleIdsHighestFirst.Count)
            throw AppProblem.BadRequest("validation.roles", "List each role once.");
        var roles = await db.Roles.Where(r => r.ServerId == serverId && !r.IsDefault && roleIdsHighestFirst.Contains(r.Id)).ToListAsync(ct);
        if (roles.Count != roleIdsHighestFirst.Count) throw AppProblem.BadRequest("validation.roles", "Unknown role.");
        foreach (var r in roles) auth.RequireRole(r.Position);

        var slots = roles.Select(r => r.Position).OrderByDescending(p => p).ToList();
        var byId = roles.ToDictionary(r => r.Id);
        for (var i = 0; i < roleIdsHighestFirst.Count; i++) byId[roleIdsHighestFirst[i]].Position = slots[i];
        var server = await db.Servers.FirstAsync(s => s.Id == serverId, ct);
        server.PolicyVersion++;
        audit.Record(actor, "server", serverId.ToString(), "role.reorder", detail: string.Join(',', roleIdsHighestFirst));
        await db.SaveChangesAsync(ct);
        await policySink.PolicyChangedAsync(serverId, server.PolicyVersion, null, ct);
    }

    public async Task RemoveMemberAsync(Guid actor, Guid serverId, Guid targetUserId, CancellationToken ct)
    {
        var auth = await permissions.RequireAuthorityAsync(actor, serverId, Permission.Administrator, ct);
        var server = await db.Servers.FirstAsync(s => s.Id == serverId, ct);
        if (server.OwnerUserId == targetUserId) throw AppProblem.Conflict("member.owner", "The owner cannot be removed.");
        if (targetUserId == actor) throw AppProblem.Conflict("member.self", "You cannot remove yourself.");
        var member = await db.ServerMembers.FirstOrDefaultAsync(m => m.ServerId == serverId && m.UserId == targetUserId && m.RemovedAt == null, ct)
                     ?? throw AppProblem.NotFound("member.not_found", "Member not found.");
        if (!auth.CanManageMember(false, await permissions.TopPositionAsync(targetUserId, serverId, ct), targetUserId))
            throw AppProblem.Forbidden("member.hierarchy", "You can only manage members below your highest role.");
        member.RemovedAt = DateTimeOffset.UtcNow;
        member.MemberVersion++;
        server.PolicyVersion++;
        audit.Record(actor, "member", targetUserId.ToString(), "member.remove");
        await db.SaveChangesAsync(ct);
        await policySink.PolicyChangedAsync(serverId, server.PolicyVersion, [targetUserId], ct);
    }

    internal static ChannelDto ToDto(Channel c, Permission mask) =>
        new(c.Id, c.ServerId, c.Type == ChannelType.Text ? "text" : "voice", c.Name, c.Topic, c.Position, (long)mask,
            (c.NextMessageSequence - 1).ToString());
}

/// <summary>Receives committed policy changes so connections, media grants and playback can be reconciled.</summary>
public interface IPolicyChangeSink
{
    /// <param name="affectedUsers">null = potentially everyone in the server.</param>
    Task PolicyChangedAsync(Guid serverId, long policyVersion, IReadOnlyCollection<Guid>? affectedUsers, CancellationToken ct);
}
