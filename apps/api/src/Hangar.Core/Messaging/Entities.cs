namespace Hangar.Core.Messaging;

public sealed class Message
{
    public Guid Id { get; set; }
    public Guid ServerId { get; set; }
    public Guid ChannelId { get; set; }
    public Guid AuthorUserId { get; set; }
    public long MessageSequence { get; set; }
    /// <summary>Author-scoped idempotency key from the client.</summary>
    public Guid ClientMessageId { get; set; }
    public string Body { get; set; } = string.Empty;
    public Guid? ReplyToId { get; set; }
    public long Version { get; set; } = 1;
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? EditedAt { get; set; }
    /// <summary>Tombstone: body cleared, row kept so replies and sync stay coherent.</summary>
    public DateTimeOffset? DeletedAt { get; set; }
    public bool Pinned { get; set; }
    public bool MentionsEveryone { get; set; }

    public List<MessageReaction> Reactions { get; set; } = [];
    public List<MessageAttachment> Attachments { get; set; } = [];
    public List<MessageMention> Mentions { get; set; } = [];
}

public sealed class MessageReaction
{
    public Guid MessageId { get; set; }
    public Guid UserId { get; set; }
    public required string EmojiKey { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class MessageAttachment
{
    public Guid MessageId { get; set; }
    public Guid FileAssetId { get; set; }
    public int Ordinal { get; set; }
}

public sealed class MessageMention
{
    public Guid MessageId { get; set; }
    public Guid MentionedUserId { get; set; }
}

public sealed class ChannelReadPosition
{
    public Guid UserId { get; set; }
    public Guid ChannelId { get; set; }
    public long LastReadMessageSequence { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

public static class ChannelEventTypes
{
    public const string MessageCreated = "message.created";
    public const string MessageUpdated = "message.updated";
    public const string MessageDeleted = "message.deleted";
    public const string ReactionAdded = "reaction.added";
    public const string ReactionRemoved = "reaction.removed";
    public const string MessagePinned = "message.pinned";
    public const string ChannelUpdated = "channel.updated";
}

/// <summary>Synchronization log and transactional outbox in one table. Delivery is at-least-once.</summary>
public sealed class ChannelEvent
{
    public Guid EventId { get; set; }
    public Guid ServerId { get; set; }
    public Guid ChannelId { get; set; }
    public long EventSequence { get; set; }
    public required string Type { get; set; }
    public Guid EntityId { get; set; }
    public long EntityVersion { get; set; }
    public Guid? ActorUserId { get; set; }
    /// <summary>JSON payload (jsonb). Bounded; deleted bodies are never stored here.</summary>
    public required string Payload { get; set; }
    public DateTimeOffset CommittedAt { get; set; }
    public DateTimeOffset? DispatchedAt { get; set; }
    public int DispatchAttempts { get; set; }
}
