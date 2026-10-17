using Hangar.Core.Channels;
using Hangar.Core.Common;
using Hangar.Core.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Hangar.Core.Permissions;

/// <summary>Loads policy input from PostgreSQL and asks <see cref="PermissionEvaluator"/>. Every command and query path uses this.</summary>
public sealed class PermissionService(HangarDbContext db)
{
    public async Task<PolicyInput> LoadInputAsync(Guid userId, Guid serverId, CancellationToken ct)
    {
        var server = await db.Servers.AsNoTracking().Where(s => s.Id == serverId)
            .Select(s => new { s.OwnerUserId }).FirstOrDefaultAsync(ct);
        var member = await db.ServerMembers.AsNoTracking()
            .AnyAsync(m => m.ServerId == serverId && m.UserId == userId && m.RemovedAt == null, ct);
        var disabled = await db.Users.AsNoTracking().Where(u => u.Id == userId)
            .Select(u => u.DisabledAt != null).FirstOrDefaultAsync(ct);

        var assigned = db.MemberRoles.Where(mr => mr.ServerId == serverId && mr.UserId == userId).Select(mr => mr.RoleId);
        var roles = await db.Roles.AsNoTracking()
            .Where(r => r.ServerId == serverId && (r.IsDefault || assigned.Contains(r.Id)))
            .Select(r => new RoleGrant(r.Id, r.PermissionMask, r.IsDefault))
            .ToListAsync(ct);

        return new PolicyInput(userId, server?.OwnerUserId, member && server is not null, disabled, roles);
    }

    public async Task<Permission> ServerPermissionsAsync(Guid userId, Guid serverId, CancellationToken ct) =>
        PermissionEvaluator.ServerLevel(await LoadInputAsync(userId, serverId, ct));

    public async Task<Permission> ChannelPermissionsAsync(Guid userId, Channel channel, CancellationToken ct)
    {
        var input = await LoadInputAsync(userId, channel.ServerId, ct);
        var overrides = await LoadOverridesAsync([channel.Id], ct);
        return PermissionEvaluator.ChannelLevel(input, channel.Type, overrides.GetValueOrDefault(channel.Id) ?? []);
    }

    /// <summary>Effective permissions for every non-archived channel in a server; channels without ViewChannel are omitted.</summary>
    public async Task<Dictionary<Guid, Permission>> VisibleChannelsAsync(Guid userId, Guid serverId, CancellationToken ct)
    {
        var input = await LoadInputAsync(userId, serverId, ct);
        var channels = await db.Channels.AsNoTracking()
            .Where(c => c.ServerId == serverId && c.ArchivedAt == null)
            .Select(c => new { c.Id, c.Type }).ToListAsync(ct);
        var overrides = await LoadOverridesAsync(channels.Select(c => c.Id).ToList(), ct);

        var result = new Dictionary<Guid, Permission>();
        foreach (var c in channels)
        {
            var mask = PermissionEvaluator.ChannelLevel(input, c.Type, overrides.GetValueOrDefault(c.Id) ?? []);
            if (mask != Permission.None) result[c.Id] = mask;
        }
        return result;
    }

    /// <summary>
    /// Loads the channel and checks the permission. Inaccessible channels are reported as 404 to avoid leaking existence.
    /// </summary>
    public async Task<(Channel Channel, Permission Mask)> RequireChannelAsync(Guid userId, Guid channelId, Permission required, CancellationToken ct)
    {
        var channel = await db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == channelId && c.ArchivedAt == null, ct)
                      ?? throw AppProblem.NotFound("channel.not_found", "Channel not found.");
        var mask = await ChannelPermissionsAsync(userId, channel, ct);
        if (!mask.HasFlag(Permission.ViewChannel)) throw AppProblem.NotFound("channel.not_found", "Channel not found.");
        if ((mask & required) != required) throw AppProblem.Forbidden();
        return (channel, mask);
    }

    public async Task RequireServerAsync(Guid userId, Guid serverId, Permission required, CancellationToken ct)
    {
        var mask = await ServerPermissionsAsync(userId, serverId, ct);
        if (mask == Permission.None) throw AppProblem.NotFound("server.not_found", "Server not found.");
        if ((mask & required) != required) throw AppProblem.Forbidden();
    }

    private async Task<Dictionary<Guid, List<ChannelOverride>>> LoadOverridesAsync(IReadOnlyCollection<Guid> channelIds, CancellationToken ct)
    {
        var rows = await db.ChannelPermissions.AsNoTracking()
            .Where(o => channelIds.Contains(o.ChannelId))
            .Select(o => new { o.ChannelId, Override = new ChannelOverride(o.RoleId, o.MemberUserId, o.AllowMask, o.DenyMask) })
            .ToListAsync(ct);
        return rows.GroupBy(r => r.ChannelId).ToDictionary(g => g.Key, g => g.Select(x => x.Override).ToList());
    }
}
