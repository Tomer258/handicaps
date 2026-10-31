using Hangar.Core.Common;
using Hangar.Core.Permissions;
using Hangar.Core.Persistence;
using Hangar.Core.Workspaces;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Hangar.Core.Channels;

public sealed record OpenDmRequest(IReadOnlyList<Guid>? UserIds, string? Name);

public sealed record DmMembersRequest(IReadOnlyList<Guid>? UserIds);

public sealed record RenameGroupRequest(string? Name);

/// <summary>
/// Direct and group messages between members of a server. They are channels of the server (type Direct/Group) whose
/// visibility comes only from <see cref="ChannelMember"/> rows (see <see cref="PermissionEvaluator.DmLevel"/>), so the
/// whole message pipeline — history, events, unread, mentions, attachments, search — applies unchanged.
/// </summary>
public sealed class DmService(HangarDbContext db, PermissionService permissions, TimeProvider clock, IPolicyChangeSink policySink)
{
    /// <summary>One other person: their conversation (created once per pair). More: a new group.</summary>
    public async Task<ChannelDto> OpenAsync(Guid userId, Guid serverId, OpenDmRequest req, CancellationToken ct)
    {
        await permissions.RequireServerAsync(userId, serverId, Permission.ViewChannel, ct);
        var others = (req.UserIds ?? []).Where(id => id != userId).Distinct().ToList();
        if (others.Count == 0) throw AppProblem.BadRequest("dm.no_one", "Pick at least one person.");
        if (others.Count + 1 > ChannelTypes.MaxGroupSize)
            throw AppProblem.BadRequest("dm.too_many", $"A group can have up to {ChannelTypes.MaxGroupSize} people.");
        await RequireMembersAsync(serverId, others, ct);
        var now = clock.GetUtcNow();

        Channel channel;
        if (others.Count == 1)
        {
            var key = DmKey(userId, others[0]);
            var existing = await db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.DmKey == key, ct);
            if (existing is not null) return await ToDtoAsync(userId, existing, ct);
            channel = NewChannel(serverId, ChannelType.Direct, "", key, now);
            try
            {
                await AddAsync(channel, [userId, others[0]], now, ct);
            }
            catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: "23505" })
            {
                // Both opened the conversation at the same moment: use the one that won.
                db.ChangeTracker.Clear();
                return await ToDtoAsync(userId, await db.Channels.AsNoTracking().FirstAsync(c => c.DmKey == key, ct), ct);
            }
        }
        else
        {
            channel = NewChannel(serverId, ChannelType.Group, GroupName(req.Name), null, now);
            await AddAsync(channel, [userId, .. others], now, ct);
        }
        await policySink.PolicyChangedAsync(serverId, 0, [userId, .. others], ct);
        return await ToDtoAsync(userId, channel, ct);
    }

    public async Task<ChannelDto> AddMembersAsync(Guid userId, Guid channelId, DmMembersRequest req, CancellationToken ct)
    {
        var channel = await RequireGroupAsync(userId, channelId, ct);
        var current = await ParticipantsAsync(channelId, ct);
        var added = (req.UserIds ?? []).Distinct().Where(id => !current.Contains(id)).ToList();
        if (added.Count == 0) return await ToDtoAsync(userId, channel, ct);
        if (current.Count + added.Count > ChannelTypes.MaxGroupSize)
            throw AppProblem.BadRequest("dm.too_many", $"A group can have up to {ChannelTypes.MaxGroupSize} people.");
        await RequireMembersAsync(channel.ServerId, added, ct);
        var now = clock.GetUtcNow();
        foreach (var id in added) db.ChannelMembers.Add(new ChannelMember { ChannelId = channelId, UserId = id, AddedAt = now });
        await db.SaveChangesAsync(ct);
        await policySink.PolicyChangedAsync(channel.ServerId, 0, [.. current, .. added], ct);
        return await ToDtoAsync(userId, channel, ct);
    }

    /// <summary>Leaves a group. The last one out archives it.</summary>
    public async Task LeaveAsync(Guid userId, Guid channelId, CancellationToken ct)
    {
        var channel = await RequireGroupAsync(userId, channelId, ct);
        var before = await ParticipantsAsync(channelId, ct);
        await db.ChannelMembers.Where(m => m.ChannelId == channelId && m.UserId == userId).ExecuteDeleteAsync(ct);
        if (before.Count <= 1)
            await db.Channels.Where(c => c.Id == channelId).ExecuteUpdateAsync(s => s.SetProperty(c => c.ArchivedAt, clock.GetUtcNow()), ct);
        await policySink.PolicyChangedAsync(channel.ServerId, 0, before, ct);
    }

    public async Task<ChannelDto> RenameAsync(Guid userId, Guid channelId, RenameGroupRequest req, CancellationToken ct)
    {
        var channel = await RequireGroupAsync(userId, channelId, ct);
        var tracked = await db.Channels.FirstAsync(c => c.Id == channelId, ct);
        tracked.Name = GroupName(req.Name);
        await db.SaveChangesAsync(ct);
        await policySink.PolicyChangedAsync(channel.ServerId, 0, await ParticipantsAsync(channelId, ct), ct);
        return await ToDtoAsync(userId, tracked, ct);
    }

    public static string DmKey(Guid a, Guid b) => a.CompareTo(b) < 0 ? $"{a:N}:{b:N}" : $"{b:N}:{a:N}";

    private static Channel NewChannel(Guid serverId, ChannelType type, string name, string? key, DateTimeOffset now) => new()
    {
        Id = Guid.CreateVersion7(), ServerId = serverId, Type = type, Name = name, DmKey = key, Position = 0, CreatedAt = now,
    };

    private async Task AddAsync(Channel channel, IReadOnlyList<Guid> people, DateTimeOffset now, CancellationToken ct)
    {
        db.Channels.Add(channel);
        foreach (var id in people) db.ChannelMembers.Add(new ChannelMember { ChannelId = channel.Id, UserId = id, AddedAt = now });
        await db.SaveChangesAsync(ct);
    }

    private static string GroupName(string? name)
    {
        var v = (name ?? "").Trim();
        if (v.Length > 48) throw AppProblem.BadRequest("validation.name", "Group names are up to 48 characters.");
        return v;
    }

    /// <summary>Active, enabled members of the server; anyone else is reported as not found (no account probing).</summary>
    private async Task RequireMembersAsync(Guid serverId, IReadOnlyCollection<Guid> userIds, CancellationToken ct)
    {
        var found = await db.ServerMembers.AsNoTracking()
            .Where(m => m.ServerId == serverId && m.RemovedAt == null && userIds.Contains(m.UserId))
            .Join(db.Users.Where(u => u.DisabledAt == null), m => m.UserId, u => u.Id, (m, u) => m.UserId)
            .CountAsync(ct);
        if (found != userIds.Count) throw AppProblem.BadRequest("dm.unknown_user", "Some of those people are not in this server.");
    }

    private async Task<Channel> RequireGroupAsync(Guid userId, Guid channelId, CancellationToken ct)
    {
        var (channel, _) = await permissions.RequireChannelAsync(userId, channelId, Permission.ViewChannel, ct);
        if (channel.Type != ChannelType.Group) throw AppProblem.BadRequest("dm.not_group", "Only group conversations can change who is in them.");
        return channel;
    }

    private Task<List<Guid>> ParticipantsAsync(Guid channelId, CancellationToken ct) =>
        db.ChannelMembers.AsNoTracking().Where(m => m.ChannelId == channelId).OrderBy(m => m.AddedAt).Select(m => m.UserId).ToListAsync(ct);

    private async Task<ChannelDto> ToDtoAsync(Guid userId, Channel channel, CancellationToken ct)
    {
        var mask = await permissions.ChannelPermissionsAsync(userId, channel, ct);
        var last = await db.Messages.AsNoTracking().Where(m => m.ChannelId == channel.Id).MaxAsync(m => (DateTimeOffset?)m.CreatedAt, ct);
        return WorkspaceService.ToDto(channel, mask, await ParticipantsAsync(channel.Id, ct), last ?? channel.CreatedAt);
    }
}
