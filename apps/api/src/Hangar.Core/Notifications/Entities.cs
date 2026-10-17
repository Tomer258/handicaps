namespace Hangar.Core.Notifications;

public static class NotificationTypes
{
    public const string Mention = "mention";
    public const string Reply = "reply";
}

public sealed class Notification
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public required string Type { get; set; }
    public Guid MessageId { get; set; }
    public Guid ChannelId { get; set; }
    public Guid? ActorUserId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? ReadAt { get; set; }
}
