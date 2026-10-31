using System.Text.RegularExpressions;
using Hangar.Core.Audit;
using Hangar.Core.Common;
using Hangar.Core.Permissions;
using Hangar.Core.Persistence;
using Hangar.Core.Workspaces;
using Microsoft.EntityFrameworkCore;

namespace Hangar.Core.Channels;

public sealed record ChannelOverrideDto(Guid Id, Guid? RoleId, Guid? MemberUserId, long Allow, long Deny);

public sealed partial class ChannelService(HangarDbContext db, PermissionService permissions, AuditService audit,
    TimeProvider clock, IPolicyChangeSink policySink)
{
    // Letters of any script (Hebrew included), digits, dash, underscore.
    [GeneratedRegex(@"[^\p{L}\p{N}_-]+")]
    private static partial Regex TextChannelInvalid();

    public async Task<ChannelDto> CreateAsync(Guid actor, Guid serverId, string type, string name, string? topic, CancellationToken ct)
    {
        await permissions.RequireServerAsync(actor, serverId, Permission.ManageChannels, ct);
        var channelType = type switch
        {
            "text" => ChannelType.Text,
            "voice" => ChannelType.Voice,
            _ => throw AppProblem.BadRequest("validation.type", "type must be text or voice."),
        };
        var count = await db.Channels.CountAsync(c => c.ServerId == serverId && c.ArchivedAt == null && (c.Type == ChannelType.Text || c.Type == ChannelType.Voice), ct);
        if (count >= 100) throw AppProblem.Conflict("channel.limit", "Channel limit reached.");

        var maxPos = await db.Channels.Where(c => c.ServerId == serverId).MaxAsync(c => (int?)c.Position, ct) ?? -1;
        var channel = new Channel
        {
            Id = Guid.CreateVersion7(),
            ServerId = serverId,
            Type = channelType,
            Name = NormalizeName(channelType, name),
            Topic = Guard.OptionalText(topic, "topic", 240),
            Position = maxPos + 1,
            CreatedAt = clock.GetUtcNow(),
        };
        db.Channels.Add(channel);
        audit.Record(actor, "channel", channel.Id.ToString(), "channel.create", detail: channel.Name);
        await db.SaveChangesAsync(ct);
        await policySink.PolicyChangedAsync(serverId, 0, null, ct);
        var mask = await permissions.ChannelPermissionsAsync(actor, channel, ct);
        return WorkspaceService.ToDto(channel, mask);
    }

    public async Task<ChannelDto> UpdateAsync(Guid actor, Guid channelId, string? name, string? topic, int? position, CancellationToken ct)
    {
        var channel = await db.Channels.FirstOrDefaultAsync(c => c.Id == channelId && c.ArchivedAt == null, ct)
                      ?? throw AppProblem.NotFound("channel.not_found", "Channel not found.");
        await permissions.RequireServerAsync(actor, channel.ServerId, Permission.ManageChannels, ct);
        if (name is not null) channel.Name = NormalizeName(channel.Type, name);
        if (topic is not null) channel.Topic = Guard.OptionalText(topic, "topic", 240);
        if (position is not null) channel.Position = Math.Clamp(position.Value, 0, 1000);
        audit.Record(actor, "channel", channel.Id.ToString(), "channel.update");
        await db.SaveChangesAsync(ct);
        await policySink.PolicyChangedAsync(channel.ServerId, 0, null, ct);
        return WorkspaceService.ToDto(channel, await permissions.ChannelPermissionsAsync(actor, channel, ct));
    }

    public async Task ArchiveAsync(Guid actor, Guid channelId, CancellationToken ct)
    {
        var channel = await db.Channels.FirstOrDefaultAsync(c => c.Id == channelId && c.ArchivedAt == null, ct)
                      ?? throw AppProblem.NotFound("channel.not_found", "Channel not found.");
        await permissions.RequireServerAsync(actor, channel.ServerId, Permission.ManageChannels, ct);
        channel.ArchivedAt = clock.GetUtcNow();
        channel.PolicyVersion++;
        audit.Record(actor, "channel", channel.Id.ToString(), "channel.archive");
        await db.SaveChangesAsync(ct);
        await policySink.PolicyChangedAsync(channel.ServerId, 0, null, ct);
    }

    public async Task<List<ChannelOverrideDto>> ListOverridesAsync(Guid actor, Guid channelId, CancellationToken ct)
    {
        var channel = await db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == channelId, ct)
                      ?? throw AppProblem.NotFound("channel.not_found", "Channel not found.");
        await permissions.RequireServerAsync(actor, channel.ServerId, Permission.ManageRoles, ct);
        return await db.ChannelPermissions.AsNoTracking().Where(o => o.ChannelId == channelId)
            .Select(o => new ChannelOverrideDto(o.Id, o.RoleId, o.MemberUserId, (long)o.AllowMask, (long)o.DenyMask)).ToListAsync(ct);
    }

    /// <summary>Upserts (or with allow=deny=0 removes) the override for one role or member.</summary>
    public async Task SetOverrideAsync(Guid actor, Guid channelId, Guid? roleId, Guid? memberUserId, long allow, long deny, CancellationToken ct)
    {
        if ((roleId is null) == (memberUserId is null))
            throw AppProblem.BadRequest("validation.subject", "Exactly one of roleId or memberUserId is required.");
        var a = (Permission)allow & Permission.All;
        var d = (Permission)deny & Permission.All;
        if ((a & d) != 0) throw AppProblem.BadRequest("validation.overlap", "A permission cannot be both allowed and denied.");

        var channel = await db.Channels.FirstOrDefaultAsync(c => c.Id == channelId && c.ArchivedAt == null, ct)
                      ?? throw AppProblem.NotFound("channel.not_found", "Channel not found.");
        var auth = await permissions.RequireAuthorityAsync(actor, channel.ServerId, Permission.ManageRoles, ct);

        // Same hierarchy as server roles: the subject must be below the caller, and nothing new may be allowed that the
        // caller does not hold (otherwise a channel override would be a way around role limits).
        if (roleId is not null)
        {
            var role = await db.Roles.AsNoTracking().FirstOrDefaultAsync(r => r.Id == roleId && r.ServerId == channel.ServerId, ct)
                       ?? throw AppProblem.NotFound("role.not_found", "Role not found.");
            auth.RequireRole(role.Position);
        }
        else
        {
            if (!await db.ServerMembers.AnyAsync(m => m.ServerId == channel.ServerId && m.UserId == memberUserId && m.RemovedAt == null, ct))
                throw AppProblem.NotFound("member.not_found", "Member not found.");
            var ownerId = await db.Servers.Where(s => s.Id == channel.ServerId).Select(s => s.OwnerUserId).FirstAsync(ct);
            if (!auth.CanManageMember(ownerId == memberUserId, await permissions.TopPositionAsync(memberUserId!.Value, channel.ServerId, ct), memberUserId.Value))
                throw AppProblem.Forbidden("member.hierarchy", "You can only manage members below your highest role.");
        }

        var existing = await db.ChannelPermissions.FirstOrDefaultAsync(o => o.ChannelId == channelId &&
            (roleId != null ? o.RoleId == roleId : o.MemberUserId == memberUserId), ct);
        auth.RequireGrant(existing?.AllowMask ?? Permission.None, a);
        if (a == 0 && d == 0)
        {
            if (existing is not null) db.ChannelPermissions.Remove(existing);
        }
        else if (existing is null)
        {
            db.ChannelPermissions.Add(new ChannelPermission
            {
                Id = Guid.CreateVersion7(), ServerId = channel.ServerId, ChannelId = channelId,
                RoleId = roleId, MemberUserId = memberUserId, AllowMask = a, DenyMask = d,
            });
        }
        else
        {
            existing.AllowMask = a;
            existing.DenyMask = d;
        }
        channel.PolicyVersion++;
        var server = await db.Servers.FirstAsync(s => s.Id == channel.ServerId, ct);
        server.PolicyVersion++;
        audit.Record(actor, "channel", channelId.ToString(), "channel.override_set", detail: $"role={roleId} member={memberUserId} allow={allow} deny={deny}");
        await db.SaveChangesAsync(ct);
        await policySink.PolicyChangedAsync(channel.ServerId, server.PolicyVersion, memberUserId is null ? null : [memberUserId.Value], ct);
    }

    private static string NormalizeName(ChannelType type, string name)
    {
        var v = Guard.Text(name, "name", 1, 48);
        if (type == ChannelType.Text)
        {
            v = TextChannelInvalid().Replace(v.ToLowerInvariant().Replace(' ', '-'), "");
            if (v.Length == 0) throw AppProblem.BadRequest("validation.name", "Channel name must contain letters or digits.");
        }
        return v;
    }
}
