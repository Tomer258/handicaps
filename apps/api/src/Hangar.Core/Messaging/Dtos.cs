namespace Hangar.Core.Messaging;

public sealed record ReactionDto(string Emoji, int Count, IReadOnlyList<Guid> UserIds);

public sealed record AttachmentDto(Guid Id, string Name, string Mime, long Size, int? Width, int? Height);

public sealed record ReplyPreviewDto(Guid Id, Guid AuthorUserId, string? BodyPreview, bool Deleted, string Kind = "default");

/// <summary>Viewer-independent message view: safe to broadcast to every authorized subscriber.</summary>
public sealed record MessageDto(
    Guid Id,
    Guid ChannelId,
    Guid AuthorUserId,
    string MessageSequence,
    Guid ClientMessageId,
    string Body,
    ReplyPreviewDto? ReplyTo,
    long Version,
    DateTimeOffset CreatedAt,
    DateTimeOffset? EditedAt,
    bool Deleted,
    bool Pinned,
    bool MentionsEveryone,
    IReadOnlyList<Guid> Mentions,
    IReadOnlyList<ReactionDto> Reactions,
    IReadOnlyList<AttachmentDto> Attachments,
    string Kind = "default");

/// <summary>Search hits, newest first. <c>Next</c> is an opaque cursor for the following (older) page.</summary>
public sealed record SearchPageDto(IReadOnlyList<MessageDto> Messages, string? Next);

public sealed record MessagePageDto(IReadOnlyList<MessageDto> Messages, bool HasMore, string HighWaterEventSequence, string? LastReadMessageSequence);

/// <summary>SignalR/REST event envelope. Clients dedupe by (channelId, eventSequence) and resync on gaps.</summary>
public sealed record ChannelEventDto(
    Guid EventId,
    Guid ChannelId,
    string EventSequence,
    string Type,
    Guid EntityId,
    long EntityVersion,
    Guid? ActorUserId,
    DateTimeOffset ServerTime,
    System.Text.Json.JsonElement Payload);

public sealed record EventPageDto(IReadOnlyList<ChannelEventDto> Events, bool HasMore, string HighWaterEventSequence);

public sealed record ReactionEventPayload(Guid MessageId, string Emoji, Guid UserId, int Count);

public sealed record PinEventPayload(Guid MessageId, bool Pinned);

public sealed record UnreadDto(Guid ChannelId, string LastMessageSequence, string LastReadMessageSequence, int Unread, int Mentions);

public sealed record SendMessageRequest(Guid ClientMessageId, string Body, Guid? ReplyToId, List<Guid>? AttachmentIds);

public sealed record EditMessageRequest(long ExpectedVersion, string Body);
