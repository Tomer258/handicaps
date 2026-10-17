using Hangar.Core.Permissions;

namespace Hangar.Core.Workspaces;

public sealed class Server
{
    public Guid Id { get; set; }
    public required string Name { get; set; }
    public Guid? OwnerUserId { get; set; }
    /// <summary>Incremented on any role/override/membership change; triggers reconciliation.</summary>
    public long PolicyVersion { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public uint Version { get; set; }
}

public sealed class ServerMember
{
    public Guid ServerId { get; set; }
    public Guid UserId { get; set; }
    public DateTimeOffset JoinedAt { get; set; }
    public DateTimeOffset? RemovedAt { get; set; }
    public long MemberVersion { get; set; }
}

public sealed class Role
{
    public Guid Id { get; set; }
    public Guid ServerId { get; set; }
    public required string Name { get; set; }
    public Permission PermissionMask { get; set; }
    /// <summary>The default role applies to every member without a MemberRole row.</summary>
    public bool IsDefault { get; set; }
    public int Position { get; set; }
    /// <summary>Optional display color for member list grouping.</summary>
    public string? Color { get; set; }
    /// <summary>Hoisted roles get their own group in the member list (e.g. Admins).</summary>
    public bool Hoist { get; set; }
}

public sealed class MemberRole
{
    public Guid ServerId { get; set; }
    public Guid UserId { get; set; }
    public Guid RoleId { get; set; }
}
