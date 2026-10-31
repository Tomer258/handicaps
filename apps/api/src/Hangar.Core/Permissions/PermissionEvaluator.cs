using Hangar.Core.Channels;

namespace Hangar.Core.Permissions;

public sealed record RoleGrant(Guid RoleId, Permission Mask, bool IsDefault);

public sealed record ChannelOverride(Guid? RoleId, Guid? MemberUserId, Permission Allow, Permission Deny);

/// <summary>Everything needed to evaluate one user's permissions; loaded once per request.</summary>
public sealed record PolicyInput(
    Guid UserId,
    Guid? OwnerUserId,
    bool IsActiveMember,
    bool AccountDisabled,
    IReadOnlyList<RoleGrant> Roles);

/// <summary>
/// The single effective-policy evaluator (docs/architecture/data-model-and-contracts.md §4):
/// 1. Removed/disabled → nothing. 2. Owner → everything. 3. Union of base role allows (default role included);
/// Administrator → everything. 4. Channel role overrides: subtract union of denies, add non-conflicting allows
/// (deny wins across roles). 5. Member override: its deny wins within it; its allow can override a role-level deny.
/// 6. Without ViewChannel nothing in the channel applies; type-specific bits are masked by channel type.
/// </summary>
public static class PermissionEvaluator
{
    public static Permission ServerLevel(PolicyInput p)
    {
        if (!p.IsActiveMember || p.AccountDisabled) return Permission.None;
        if (p.OwnerUserId == p.UserId) return Permission.All;

        var mask = Permission.None;
        foreach (var r in p.Roles) mask |= r.Mask;
        return mask.HasFlag(Permission.Administrator) ? Permission.All : mask;
    }

    /// <summary>
    /// Direct/group messages: only participants, and only while active members of the server. Owner/Administrator get no
    /// bypass (nobody reads other people's DMs); roles still limit sending, attaching and reacting server-wide.
    /// </summary>
    public static Permission DmLevel(PolicyInput p, bool isParticipant)
    {
        var baseMask = ServerLevel(p);
        if (!isParticipant || baseMask == Permission.None) return Permission.None;
        return Permission.ViewChannel | (baseMask & (Permission.SendMessages | Permission.AttachFiles | Permission.AddReactions));
    }

    public static Permission ChannelLevel(PolicyInput p, ChannelType type, IReadOnlyList<ChannelOverride> overrides)
    {
        var baseMask = ServerLevel(p);
        if (baseMask == Permission.None) return Permission.None;

        var isPrivileged = p.OwnerUserId == p.UserId || baseMask == Permission.All;
        var mask = baseMask;

        if (!isPrivileged)
        {
            var roleIds = p.Roles.Select(r => r.RoleId).ToHashSet();
            Permission roleAllow = Permission.None, roleDeny = Permission.None;
            foreach (var o in overrides)
            {
                if (o.RoleId is { } rid && roleIds.Contains(rid))
                {
                    roleAllow |= o.Allow;
                    roleDeny |= o.Deny;
                }
            }
            mask = (mask & ~roleDeny) | (roleAllow & ~roleDeny);

            var member = overrides.FirstOrDefault(o => o.MemberUserId == p.UserId);
            if (member is not null)
                mask = (mask & ~member.Deny) | (member.Allow & ~member.Deny);
        }

        if (!mask.HasFlag(Permission.ViewChannel)) return Permission.None;

        mask &= ChannelTypes.IsText(type) ? ~PermissionSets.VoiceOnly : ~PermissionSets.TextOnly;
        return mask;
    }
}
