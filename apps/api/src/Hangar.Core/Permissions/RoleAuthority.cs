using Hangar.Core.Common;

namespace Hangar.Core.Permissions;

/// <summary>
/// Role hierarchy for administration. The owner manages everything. Anyone else (Manage roles or Administrator) only
/// manages roles strictly below their own highest role, only manages members whose highest role is below theirs, and
/// never grants a permission they do not hold themselves. Without this, Manage roles alone could self-escalate.
/// </summary>
public sealed record RoleAuthority(Guid ActorUserId, bool IsOwner, Permission Mask, int TopPosition)
{
    public bool CanManageRole(int rolePosition) => IsOwner || rolePosition < TopPosition;

    public bool CanManageMember(bool targetIsOwner, int targetTopPosition, Guid targetUserId) =>
        !targetIsOwner && (IsOwner || targetUserId == ActorUserId || targetTopPosition < TopPosition);

    public bool CanGrant(Permission bits) => IsOwner || (bits & ~Mask) == 0;

    public void RequireRole(int rolePosition)
    {
        if (!CanManageRole(rolePosition))
            throw AppProblem.Forbidden("role.hierarchy", "You can only manage roles below your highest role.");
    }

    /// <summary>Only newly granted bits are checked: removing permissions from a manageable role is always allowed.</summary>
    public void RequireGrant(Permission before, Permission after)
    {
        if (!CanGrant(after & ~before))
            throw AppProblem.Forbidden("role.grant", "You cannot grant permissions you do not have.");
    }
}
