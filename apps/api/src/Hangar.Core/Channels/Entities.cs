using Hangar.Core.Permissions;

namespace Hangar.Core.Channels;

public enum ChannelType
{
    Text = 0,
    Voice = 1,
    /// <summary>Direct message between two members of the server (unique per pair through <see cref="Channel.DmKey"/>).</summary>
    Direct = 2,
    /// <summary>Group direct message (up to <see cref="ChannelTypes.MaxGroupSize"/> people).</summary>
    Group = 3,
}

public static class ChannelTypes
{
    public const int MaxGroupSize = 10;

    /// <summary>Channels that carry messages: server text channels and direct messages.</summary>
    public static bool IsText(ChannelType t) => t is ChannelType.Text or ChannelType.Direct or ChannelType.Group;

    /// <summary>Direct/group messages: visible to their participants only (no roles, overrides or admin bypass).</summary>
    public static bool IsDm(ChannelType t) => t is ChannelType.Direct or ChannelType.Group;
}

public sealed class Channel
{
    public Guid Id { get; set; }
    public Guid ServerId { get; set; }
    public ChannelType Type { get; set; }
    public required string Name { get; set; }
    public string? Topic { get; set; }
    public int Position { get; set; }
    public DateTimeOffset? ArchivedAt { get; set; }
    /// <summary>Next message sequence to allocate. Advanced only under the channel row lock.</summary>
    public long NextMessageSequence { get; set; } = 1;
    /// <summary>Next event sequence to allocate. Advanced only under the channel row lock.</summary>
    public long NextEventSequence { get; set; } = 1;
    public long PolicyVersion { get; set; }
    /// <summary>Voice: incremented to force a new LiveKit room name (e.g. after reset).</summary>
    public long MediaGeneration { get; set; } = 1;
    public DateTimeOffset CreatedAt { get; set; }
    public uint Version { get; set; }
    /// <summary>Direct messages: "{smaller user id}:{larger user id}", unique, so a pair has exactly one conversation.</summary>
    public string? DmKey { get; set; }
}

/// <summary>A participant of a direct or group message channel.</summary>
public sealed class ChannelMember
{
    public Guid ChannelId { get; set; }
    public Guid UserId { get; set; }
    public DateTimeOffset AddedAt { get; set; }
}

/// <summary>A channel override for exactly one subject: a role or a member.</summary>
public sealed class ChannelPermission
{
    public Guid Id { get; set; }
    public Guid ServerId { get; set; }
    public Guid ChannelId { get; set; }
    public Guid? RoleId { get; set; }
    public Guid? MemberUserId { get; set; }
    public Permission AllowMask { get; set; }
    public Permission DenyMask { get; set; }
}
