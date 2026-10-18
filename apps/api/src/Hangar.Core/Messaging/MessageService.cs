using System.Data;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Hangar.Core.Channels;
using Hangar.Core.Common;
using Hangar.Core.Files;
using Hangar.Core.Notifications;
using Hangar.Core.Permissions;
using Hangar.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Hangar.Core.Messaging;

/// <summary>Wakes the outbox dispatcher after a commit (the dispatcher also polls, so a missed signal only adds latency).</summary>
public interface IOutboxSignal
{
    void Notify();
}

/// <summary>
/// Durable text messaging. Every mutation: lock the channel row → check permission → allocate sequences →
/// persist change + ChannelEvent (outbox) → commit → wake dispatcher. Sequence allocation happens under the
/// same row lock as the commit, so a later sequence never becomes visible before an earlier one.
/// </summary>
public sealed partial class MessageService(
    HangarDbContext db,
    PermissionService permissions,
    TimeProvider clock,
    IOutboxSignal outbox)
{
    public const int MaxBody = 4000;
    public const int MaxAttachments = 10;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    [GeneratedRegex(@"<@([0-9a-fA-F-]{36})>")]
    private static partial Regex MentionToken();

    // ---------------- Queries ----------------

    public async Task<MessagePageDto> HistoryAsync(Guid userId, Guid channelId, string? before, int? limit, CancellationToken ct)
    {
        var (channel, _) = await permissions.RequireChannelAsync(userId, channelId, Permission.ViewChannel, ct);
        if (channel.Type != ChannelType.Text) throw AppProblem.BadRequest("channel.not_text", "Not a text channel.");
        var beforeSeq = Guard.Cursor(before, "before") ?? long.MaxValue;
        var take = Guard.Limit(limit, 50, 100);

        // Repeatable read: the page and the high-water cursor come from one consistent snapshot.
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        var rows = await db.Messages.AsNoTracking()
            .Where(m => m.ChannelId == channelId && m.MessageSequence < beforeSeq)
            .OrderByDescending(m => m.MessageSequence)
            .Take(take + 1)
            .Include(m => m.Reactions).Include(m => m.Attachments).Include(m => m.Mentions)
            .AsSplitQuery()
            .ToListAsync(ct);
        var highWater = await db.Channels.Where(c => c.Id == channelId).Select(c => c.NextEventSequence - 1).FirstAsync(ct);
        var lastRead = await db.ChannelReadPositions.Where(r => r.UserId == userId && r.ChannelId == channelId)
            .Select(r => (long?)r.LastReadMessageSequence).FirstOrDefaultAsync(ct);
        await tx.CommitAsync(ct);

        var hasMore = rows.Count > take;
        var page = rows.Take(take).Reverse().ToList();
        var dtos = await ToDtosAsync(page, ct);
        return new MessagePageDto(dtos, hasMore, highWater.ToString(), lastRead?.ToString());
    }

    public const int MaxSearchQuery = 100;

    /// <summary>
    /// Server-wide message search over the channels the caller can currently see. Substring match (ILIKE, backed by a
    /// pg_trgm index) so Hebrew and other scripts work without language-specific stemming. Tombstones are excluded.
    /// </summary>
    public async Task<SearchPageDto> SearchAsync(Guid userId, Guid serverId, string? q, Guid? fromUserId, Guid? channelId,
        string? before, int? limit, CancellationToken ct)
    {
        var text = (q ?? "").Trim();
        if (text.Length > MaxSearchQuery) throw AppProblem.BadRequest("search.too_long", $"Search is limited to {MaxSearchQuery} characters.");
        if (text.Length == 0 && fromUserId is null) throw AppProblem.BadRequest("search.empty", "Type something to search for.");
        var take = Guard.Limit(limit, 25, 50);

        var visible = await permissions.VisibleChannelsAsync(userId, serverId, ct);
        if (visible.Count == 0) throw AppProblem.NotFound("server.not_found", "Server not found.");
        var channelIds = visible.Where(kv => kv.Value.HasFlag(Permission.ViewChannel)).Select(kv => kv.Key).ToList();
        if (channelId is { } only) channelIds = channelIds.Contains(only) ? [only] : [];
        if (channelIds.Count == 0) return new SearchPageDto([], null);

        var query = db.Messages.AsNoTracking()
            .Where(m => m.ServerId == serverId && channelIds.Contains(m.ChannelId) && m.DeletedAt == null);
        if (text.Length > 0)
        {
            // User text is literal: escape LIKE wildcards with '\'.
            var pattern = "%" + text.Replace(@"\", @"\\").Replace("%", @"\%").Replace("_", @"\_") + "%";
            query = query.Where(m => EF.Functions.ILike(m.Body, pattern, @"\"));
        }
        if (fromUserId is { } author) query = query.Where(m => m.AuthorUserId == author);
        if (before is not null)
        {
            if (!long.TryParse(before, out var ticks) || ticks <= 0) throw AppProblem.BadRequest("validation.cursor", "Invalid cursor.");
            var cutoff = new DateTimeOffset(ticks, TimeSpan.Zero);
            query = query.Where(m => m.CreatedAt < cutoff);
        }

        var rows = await query.OrderByDescending(m => m.CreatedAt).Take(take + 1)
            .Include(m => m.Reactions).Include(m => m.Attachments).Include(m => m.Mentions)
            .AsSplitQuery().ToListAsync(ct);
        var page = rows.Take(take).ToList();
        var next = rows.Count > take ? page[^1].CreatedAt.UtcTicks.ToString() : null;
        return new SearchPageDto(await ToDtosAsync(page, ct), next);
    }

    public async Task<List<MessageDto>> PinnedAsync(Guid userId, Guid channelId, CancellationToken ct)
    {
        await permissions.RequireChannelAsync(userId, channelId, Permission.ViewChannel, ct);
        var rows = await db.Messages.AsNoTracking()
            .Where(m => m.ChannelId == channelId && m.Pinned && m.DeletedAt == null)
            .OrderByDescending(m => m.MessageSequence).Take(50)
            .Include(m => m.Reactions).Include(m => m.Attachments).Include(m => m.Mentions).AsSplitQuery()
            .ToListAsync(ct);
        return await ToDtosAsync(rows, ct);
    }

    /// <summary>Ordered mutations after a cursor. Returns 410 events.reset when the cursor predates retention.</summary>
    public async Task<EventPageDto> EventsAsync(Guid userId, Guid channelId, string? after, int? limit, CancellationToken ct)
    {
        await permissions.RequireChannelAsync(userId, channelId, Permission.ViewChannel, ct);
        var afterSeq = Guard.Cursor(after, "after") ?? 0;
        var take = Guard.Limit(limit, 200, 500);

        var highWater = await db.Channels.Where(c => c.Id == channelId).Select(c => c.NextEventSequence - 1).FirstAsync(ct);
        if (afterSeq < highWater)
        {
            var oldest = await db.ChannelEvents.Where(e => e.ChannelId == channelId).MinAsync(e => (long?)e.EventSequence, ct);
            if (oldest is null || afterSeq < oldest.Value - 1)
                throw new AppProblem(410, "events.reset", "History changed too long ago. Reload the channel.");
        }

        var rows = await db.ChannelEvents.AsNoTracking()
            .Where(e => e.ChannelId == channelId && e.EventSequence > afterSeq)
            .OrderBy(e => e.EventSequence).Take(take + 1).ToListAsync(ct);
        return new EventPageDto(rows.Take(take).Select(ToDto).ToList(), rows.Count > take, highWater.ToString());
    }

    public async Task<List<UnreadDto>> UnreadOverviewAsync(Guid userId, Guid serverId, CancellationToken ct)
    {
        var visible = await permissions.VisibleChannelsAsync(userId, serverId, ct);
        var ids = visible.Keys.ToList();
        var channels = await db.Channels.AsNoTracking()
            .Where(c => ids.Contains(c.Id) && c.Type == ChannelType.Text)
            .Select(c => new { c.Id, Last = c.NextMessageSequence - 1 }).ToListAsync(ct);
        var reads = await db.ChannelReadPositions.AsNoTracking()
            .Where(r => r.UserId == userId && ids.Contains(r.ChannelId))
            .ToDictionaryAsync(r => r.ChannelId, r => r.LastReadMessageSequence, ct);
        var mentions = await db.Notifications.AsNoTracking()
            .Where(n => n.UserId == userId && n.ReadAt == null && ids.Contains(n.ChannelId))
            .GroupBy(n => n.ChannelId).Select(g => new { g.Key, Count = g.Count() })
            .ToDictionaryAsync(x => x.Key, x => x.Count, ct);

        var result = new List<UnreadDto>();
        foreach (var c in channels)
        {
            var read = reads.GetValueOrDefault(c.Id);
            var unread = c.Last > read
                ? await db.Messages.CountAsync(m => m.ChannelId == c.Id && m.MessageSequence > read && m.DeletedAt == null && m.AuthorUserId != userId, ct)
                : 0;
            result.Add(new UnreadDto(c.Id, c.Last.ToString(), read.ToString(), Math.Min(unread, 999), mentions.GetValueOrDefault(c.Id)));
        }
        return result;
    }

    // ---------------- Commands ----------------

    public async Task<(MessageDto Message, bool Created)> SendAsync(Guid userId, Guid channelId, SendMessageRequest req, CancellationToken ct)
    {
        if (req.ClientMessageId == Guid.Empty) throw AppProblem.BadRequest("validation.clientMessageId", "clientMessageId is required.");
        var body = NormalizeBody(req.Body);
        var attachmentIds = (req.AttachmentIds ?? []).Distinct().ToList();
        if (attachmentIds.Count > MaxAttachments) throw AppProblem.BadRequest("validation.attachments", "Too many attachments.");
        if (body.Length == 0 && attachmentIds.Count == 0) throw AppProblem.BadRequest("validation.body", "Message cannot be empty.");

        // Idempotent retry: same author + clientMessageId returns the original result.
        var existing = await db.Messages.AsNoTracking().FirstOrDefaultAsync(m => m.AuthorUserId == userId && m.ClientMessageId == req.ClientMessageId, ct);
        if (existing is not null) return (await ExistingForRetryAsync(existing, channelId, body, ct), false);

        var required = Permission.SendMessages | (attachmentIds.Count > 0 ? Permission.AttachFiles : Permission.None);
        var (_, mask) = await permissions.RequireChannelAsync(userId, channelId, required, ct);
        if (mask == Permission.None) throw AppProblem.Forbidden();

        var now = clock.GetUtcNow();
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var channel = await LockChannelAsync(channelId, ct);
        if (channel.Type != ChannelType.Text) throw AppProblem.BadRequest("channel.not_text", "Not a text channel.");

        if (req.ReplyToId is { } replyId && !await db.Messages.AnyAsync(m => m.Id == replyId && m.ChannelId == channelId, ct))
            throw AppProblem.BadRequest("validation.replyTo", "Reply target must be in the same channel.");

        var message = new Message
        {
            Id = Guid.CreateVersion7(),
            ServerId = channel.ServerId,
            ChannelId = channelId,
            AuthorUserId = userId,
            ClientMessageId = req.ClientMessageId,
            Body = body,
            ReplyToId = req.ReplyToId,
            CreatedAt = now,
            MessageSequence = channel.NextMessageSequence++,
            MentionsEveryone = body.Contains("@everyone") && mask.HasFlag(Permission.MentionEveryone),
        };

        // Attachments: ownership, server, pending/ready state and single-message use are all verified here.
        if (attachmentIds.Count > 0)
        {
            var assets = await db.FileAssets.Where(f => attachmentIds.Contains(f.Id)).ToListAsync(ct);
            var linked = await db.MessageAttachments.Where(a => attachmentIds.Contains(a.FileAssetId)).AnyAsync(ct);
            if (linked || assets.Count != attachmentIds.Count || assets.Any(a =>
                    a.OwnerUserId != userId || a.ServerId != channel.ServerId || a.Purpose != FilePurpose.Attachment || a.State != FileState.Ready))
                throw AppProblem.BadRequest("validation.attachments", "One or more attachments are not available.");
            var ordinal = 0;
            foreach (var id in attachmentIds) message.Attachments.Add(new MessageAttachment { FileAssetId = id, Ordinal = ordinal++ });
        }

        // Mentions: only members who can actually see this channel get a mention row and a notification.
        var mentioned = await VisibleMentionsAsync(channel, body, userId, ct);
        foreach (var uid in mentioned) message.Mentions.Add(new MessageMention { MentionedUserId = uid });
        db.Messages.Add(message);

        foreach (var uid in mentioned)
            db.Notifications.Add(new Notification
            {
                Id = Guid.CreateVersion7(), UserId = uid, Type = NotificationTypes.Mention, MessageId = message.Id,
                ChannelId = channelId, ActorUserId = userId, CreatedAt = now,
            });

        var dto = await ToDtoAsync(message, ct);
        AddEvent(channel, ChannelEventTypes.MessageCreated, message.Id, message.Version, userId, dto, now);

        try
        {
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: "23505" })
        {
            // A concurrent retry with the same key won the race: return its committed result.
            await tx.RollbackAsync(ct);
            db.ChangeTracker.Clear();
            var winner = await db.Messages.AsNoTracking().FirstAsync(m => m.AuthorUserId == userId && m.ClientMessageId == req.ClientMessageId, ct);
            return (await ExistingForRetryAsync(winner, channelId, body, ct), false);
        }
        outbox.Notify();
        return (dto, true);
    }

    /// <summary>
    /// "X joined" in the first text channel (by position) the new member can see. Best effort: the caller ignores
    /// failures, and a server without a visible text channel simply gets no welcome.
    /// </summary>
    public async Task<MessageDto?> PostMemberJoinedAsync(Guid userId, Guid serverId, CancellationToken ct)
    {
        var candidates = await db.Channels.AsNoTracking()
            .Where(c => c.ServerId == serverId && c.Type == ChannelType.Text && c.ArchivedAt == null)
            .OrderBy(c => c.Position).ThenBy(c => c.CreatedAt).ToListAsync(ct);
        Guid? target = null;
        foreach (var c in candidates)
            if ((await permissions.ChannelPermissionsAsync(userId, c, ct)).HasFlag(Permission.ViewChannel)) { target = c.Id; break; }
        if (target is null) return null;

        var now = clock.GetUtcNow();
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var channel = await LockChannelAsync(target.Value, ct);
        var message = new Message
        {
            Id = Guid.CreateVersion7(),
            ServerId = channel.ServerId,
            ChannelId = channel.Id,
            AuthorUserId = userId,
            ClientMessageId = Guid.CreateVersion7(),
            Kind = MessageKind.MemberJoined,
            CreatedAt = now,
            MessageSequence = channel.NextMessageSequence++,
        };
        db.Messages.Add(message);
        var dto = await ToDtoAsync(message, ct);
        AddEvent(channel, ChannelEventTypes.MessageCreated, message.Id, message.Version, userId, dto, now);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        outbox.Notify();
        return dto;
    }

    public async Task<MessageDto> EditAsync(Guid userId, Guid messageId, EditMessageRequest req, CancellationToken ct)
    {
        var body = NormalizeBody(req.Body);
        if (body.Length == 0) throw AppProblem.BadRequest("validation.body", "Message cannot be empty.");
        var target = await db.Messages.AsNoTracking().FirstOrDefaultAsync(m => m.Id == messageId, ct)
                     ?? throw AppProblem.NotFound("message.not_found", "Message not found.");
        await permissions.RequireChannelAsync(userId, target.ChannelId, Permission.SendMessages, ct);
        if (target.AuthorUserId != userId) throw AppProblem.Forbidden("message.not_author", "You can only edit your own messages.");
        if (target.Kind != MessageKind.Default) throw AppProblem.BadRequest("message.system", "This message can't be edited.");

        var now = clock.GetUtcNow();
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var channel = await LockChannelAsync(target.ChannelId, ct);
        var message = await LoadForMutationAsync(messageId, ct);
        if (message.DeletedAt != null) throw AppProblem.Conflict("message.deleted", "This message was deleted.");
        if (message.Version != req.ExpectedVersion) throw AppProblem.Conflict("message.version", "This message changed. Reload and try again.");

        message.Body = body;
        message.EditedAt = now;
        message.Version++;
        // Re-evaluate mentions; new mentions notify once per message (dedup key user/message/type).
        var mentioned = await VisibleMentionsAsync(channel, body, userId, ct);
        message.Mentions.RemoveAll(m => !mentioned.Contains(m.MentionedUserId));
        foreach (var uid in mentioned.Where(u => message.Mentions.All(m => m.MentionedUserId != u)))
        {
            message.Mentions.Add(new MessageMention { MentionedUserId = uid });
            if (!await db.Notifications.AnyAsync(n => n.UserId == uid && n.MessageId == message.Id && n.Type == NotificationTypes.Mention, ct))
                db.Notifications.Add(new Notification
                {
                    Id = Guid.CreateVersion7(), UserId = uid, Type = NotificationTypes.Mention, MessageId = message.Id,
                    ChannelId = message.ChannelId, ActorUserId = userId, CreatedAt = now,
                });
        }

        var dto = await ToDtoAsync(message, ct);
        AddEvent(channel, ChannelEventTypes.MessageUpdated, message.Id, message.Version, userId, dto, now);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        outbox.Notify();
        return dto;
    }

    public async Task DeleteAsync(Guid userId, Guid messageId, long? expectedVersion, CancellationToken ct)
    {
        var target = await db.Messages.AsNoTracking().FirstOrDefaultAsync(m => m.Id == messageId, ct)
                     ?? throw AppProblem.NotFound("message.not_found", "Message not found.");
        var (_, mask) = await permissions.RequireChannelAsync(userId, target.ChannelId, Permission.ViewChannel, ct);
        if (target.AuthorUserId != userId && !mask.HasFlag(Permission.ManageMessages)) throw AppProblem.Forbidden();
        if (target.DeletedAt != null) return; // idempotent

        var now = clock.GetUtcNow();
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var channel = await LockChannelAsync(target.ChannelId, ct);
        var message = await LoadForMutationAsync(messageId, ct);
        if (message.DeletedAt != null) return;
        if (expectedVersion is not null && message.Version != expectedVersion) throw AppProblem.Conflict("message.version", "This message changed. Reload and try again.");

        // Tombstone: keep id/sequence, clear content, drop reactions/mentions/attachment links.
        message.Body = string.Empty;
        message.DeletedAt = now;
        message.Pinned = false;
        message.Version++;
        message.Reactions.Clear();
        message.Mentions.Clear();
        // Attachment bytes go with the message (the GC removes the files); they never become readable orphans.
        var attachmentIds = message.Attachments.Select(a => a.FileAssetId).ToList();
        message.Attachments.Clear();
        if (attachmentIds.Count > 0)
            await db.FileAssets.Where(f => attachmentIds.Contains(f.Id))
                .ExecuteUpdateAsync(u => u.SetProperty(f => f.State, Files.FileState.Deleted).SetProperty(f => f.DeletedAt, now), ct);
        await db.Notifications.Where(n => n.MessageId == messageId).ExecuteDeleteAsync(ct);

        var dto = await ToDtoAsync(message, ct);
        AddEvent(channel, ChannelEventTypes.MessageDeleted, message.Id, message.Version, userId, dto, now);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        outbox.Notify();
    }

    public async Task SetReactionAsync(Guid userId, Guid messageId, string emoji, bool add, CancellationToken ct)
    {
        var key = NormalizeEmoji(emoji);
        var target = await db.Messages.AsNoTracking().FirstOrDefaultAsync(m => m.Id == messageId, ct)
                     ?? throw AppProblem.NotFound("message.not_found", "Message not found.");
        await permissions.RequireChannelAsync(userId, target.ChannelId, add ? Permission.AddReactions : Permission.ViewChannel, ct);
        if (target.DeletedAt != null) throw AppProblem.Conflict("message.deleted", "This message was deleted.");

        var now = clock.GetUtcNow();
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var channel = await LockChannelAsync(target.ChannelId, ct);
        var exists = await db.MessageReactions.AnyAsync(r => r.MessageId == messageId && r.UserId == userId && r.EmojiKey == key, ct);
        if (exists == add) return; // idempotent no-op, no event
        if (add)
        {
            var distinct = await db.MessageReactions.Where(r => r.MessageId == messageId).Select(r => r.EmojiKey).Distinct().CountAsync(ct);
            if (distinct >= 20 && !await db.MessageReactions.AnyAsync(r => r.MessageId == messageId && r.EmojiKey == key, ct))
                throw AppProblem.Conflict("reaction.limit", "Too many different reactions on this message.");
            db.MessageReactions.Add(new MessageReaction { MessageId = messageId, UserId = userId, EmojiKey = key, CreatedAt = now });
        }
        else
        {
            await db.MessageReactions.Where(r => r.MessageId == messageId && r.UserId == userId && r.EmojiKey == key).ExecuteDeleteAsync(ct);
        }
        await db.SaveChangesAsync(ct);
        var count = await db.MessageReactions.CountAsync(r => r.MessageId == messageId && r.EmojiKey == key, ct);
        AddEvent(channel, add ? ChannelEventTypes.ReactionAdded : ChannelEventTypes.ReactionRemoved, messageId, 0, userId,
            new ReactionEventPayload(messageId, key, userId, count), now);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        outbox.Notify();
    }

    public async Task SetPinnedAsync(Guid userId, Guid messageId, bool pinned, CancellationToken ct)
    {
        var target = await db.Messages.AsNoTracking().FirstOrDefaultAsync(m => m.Id == messageId, ct)
                     ?? throw AppProblem.NotFound("message.not_found", "Message not found.");
        await permissions.RequireChannelAsync(userId, target.ChannelId, Permission.ManageMessages, ct);
        if (target.DeletedAt != null || target.Pinned == pinned) return;

        var now = clock.GetUtcNow();
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var channel = await LockChannelAsync(target.ChannelId, ct);
        var message = await db.Messages.FirstAsync(m => m.Id == messageId, ct);
        message.Pinned = pinned;
        AddEvent(channel, ChannelEventTypes.MessagePinned, messageId, message.Version, userId, new PinEventPayload(messageId, pinned), now);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        outbox.Notify();
    }

    /// <summary>Monotonic: never moves backwards. Also marks mention notifications up to that point as read.</summary>
    public async Task UpdateReadPositionAsync(Guid userId, Guid channelId, string sequence, CancellationToken ct)
    {
        await permissions.RequireChannelAsync(userId, channelId, Permission.ViewChannel, ct);
        var seq = Guard.Cursor(sequence, "messageSequence") ?? 0;
        var max = await db.Channels.Where(c => c.Id == channelId).Select(c => c.NextMessageSequence - 1).FirstAsync(ct);
        seq = Math.Min(seq, max);
        var now = clock.GetUtcNow();

        await db.Database.ExecuteSqlAsync($"""
            INSERT INTO channel_read_positions (user_id, channel_id, last_read_message_sequence, updated_at)
            VALUES ({userId}, {channelId}, {seq}, {now})
            ON CONFLICT (user_id, channel_id) DO UPDATE
              SET last_read_message_sequence = GREATEST(channel_read_positions.last_read_message_sequence, EXCLUDED.last_read_message_sequence),
                  updated_at = EXCLUDED.updated_at
            """, ct);

        await db.Notifications
            .Where(n => n.UserId == userId && n.ChannelId == channelId && n.ReadAt == null &&
                        db.Messages.Any(m => m.Id == n.MessageId && m.MessageSequence <= seq))
            .ExecuteUpdateAsync(s => s.SetProperty(n => n.ReadAt, now), ct);
    }

    // ---------------- Helpers ----------------

    private async Task<Channel> LockChannelAsync(Guid channelId, CancellationToken ct) =>
        await db.Channels.FromSql($"SELECT *, xmin FROM channels WHERE id = {channelId} FOR UPDATE").FirstOrDefaultAsync(ct)
        ?? throw AppProblem.NotFound("channel.not_found", "Channel not found.");

    private Task<Message> LoadForMutationAsync(Guid id, CancellationToken ct) =>
        db.Messages.Include(m => m.Reactions).Include(m => m.Attachments).Include(m => m.Mentions).AsSplitQuery()
            .FirstAsync(m => m.Id == id, ct);

    private void AddEvent(Channel channel, string type, Guid entityId, long entityVersion, Guid actor, object payload, DateTimeOffset now)
    {
        db.ChannelEvents.Add(new ChannelEvent
        {
            EventId = Guid.CreateVersion7(),
            ServerId = channel.ServerId,
            ChannelId = channel.Id,
            EventSequence = channel.NextEventSequence++,
            Type = type,
            EntityId = entityId,
            EntityVersion = entityVersion,
            ActorUserId = actor,
            Payload = JsonSerializer.Serialize(payload, Json),
            CommittedAt = now,
        });
    }

    private async Task<MessageDto> ExistingForRetryAsync(Message existing, Guid channelId, string body, CancellationToken ct)
    {
        if (existing.ChannelId != channelId || (existing.DeletedAt == null && existing.Body != body))
            throw AppProblem.Conflict("message.idempotency_conflict", "This message id was already used with different content.");
        await permissions.RequireChannelAsync(existing.AuthorUserId, channelId, Permission.ViewChannel, ct);
        var full = await db.Messages.AsNoTracking().Include(m => m.Reactions).Include(m => m.Attachments).Include(m => m.Mentions)
            .AsSplitQuery().FirstAsync(m => m.Id == existing.Id, ct);
        return await ToDtoAsync(full, ct);
    }

    private async Task<HashSet<Guid>> VisibleMentionsAsync(Channel channel, string body, Guid author, CancellationToken ct)
    {
        var ids = MentionToken().Matches(body).Select(m => Guid.TryParse(m.Groups[1].Value, out var g) ? g : Guid.Empty)
            .Where(g => g != Guid.Empty && g != author).Distinct().Take(20).ToList();
        var result = new HashSet<Guid>();
        foreach (var uid in ids)
        {
            var mask = await permissions.ChannelPermissionsAsync(uid, channel, ct);
            if (mask.HasFlag(Permission.ViewChannel)) result.Add(uid);
        }
        return result;
    }

    private static string NormalizeBody(string? body)
    {
        var v = (body ?? string.Empty).Normalize(NormalizationForm.FormC).Trim();
        if (v.Length > MaxBody) throw AppProblem.TooLarge("validation.body", $"Message is longer than {MaxBody} characters.");
        // Strip control characters except newline/tab.
        return new string(v.Where(ch => ch is '\n' or '\t' || !char.IsControl(ch)).ToArray());
    }

    public static string NormalizeEmoji(string? emoji)
    {
        var v = Uri.UnescapeDataString(emoji ?? string.Empty).Normalize(NormalizationForm.FormC).Trim();
        if (v.Length is 0 or > 32 || v.Any(ch => char.IsControl(ch) || char.IsWhiteSpace(ch) || ch is '<' or '>' or '&' or '"'))
            throw AppProblem.BadRequest("validation.emoji", "Invalid reaction.");
        return v;
    }

    private async Task<MessageDto> ToDtoAsync(Message m, CancellationToken ct) => (await ToDtosAsync([m], ct))[0];

    private async Task<List<MessageDto>> ToDtosAsync(IReadOnlyList<Message> messages, CancellationToken ct)
    {
        var replyIds = messages.Where(m => m.ReplyToId != null).Select(m => m.ReplyToId!.Value).Distinct().ToList();
        var replies = replyIds.Count == 0 ? new Dictionary<Guid, ReplyPreviewDto>() : await db.Messages.AsNoTracking()
            .Where(m => replyIds.Contains(m.Id))
            .Select(m => new ReplyPreviewDto(m.Id, m.AuthorUserId, m.DeletedAt == null ? (m.Body.Length > 140 ? m.Body.Substring(0, 140) : m.Body) : null, m.DeletedAt != null,
                m.Kind == MessageKind.MemberJoined ? "memberJoined" : "default"))
            .ToDictionaryAsync(r => r.Id, ct);

        var assetIds = messages.SelectMany(m => m.Attachments).Select(a => a.FileAssetId).Distinct().ToList();
        var assets = assetIds.Count == 0 ? new Dictionary<Guid, FileAsset>() : await db.FileAssets.AsNoTracking()
            .Where(f => assetIds.Contains(f.Id)).ToDictionaryAsync(f => f.Id, ct);

        return messages.Select(m => new MessageDto(
            m.Id, m.ChannelId, m.AuthorUserId, m.MessageSequence.ToString(), m.ClientMessageId,
            m.DeletedAt == null ? m.Body : string.Empty,
            m.ReplyToId is { } r && replies.TryGetValue(r, out var rp) ? rp : null,
            m.Version, m.CreatedAt, m.EditedAt, m.DeletedAt != null, m.Pinned, m.MentionsEveryone,
            m.Mentions.Select(x => x.MentionedUserId).ToList(),
            m.Reactions.GroupBy(x => x.EmojiKey)
                .Select(g => new ReactionDto(g.Key, g.Count(), g.OrderBy(x => x.CreatedAt).Select(x => x.UserId).Take(50).ToList()))
                .OrderBy(x => x.Emoji, StringComparer.Ordinal).ToList(),
            m.Attachments.OrderBy(a => a.Ordinal).Where(a => assets.ContainsKey(a.FileAssetId)).Select(a =>
            {
                var f = assets[a.FileAssetId];
                return new AttachmentDto(f.Id, f.OriginalName, f.Mime, f.SizeBytes, f.Width, f.Height);
            }).ToList(),
            m.Kind == MessageKind.MemberJoined ? "memberJoined" : "default")).ToList();
    }

    public static ChannelEventDto ToDto(ChannelEvent e) => new(
        e.EventId, e.ChannelId, e.EventSequence.ToString(), e.Type, e.EntityId, e.EntityVersion, e.ActorUserId, e.CommittedAt,
        JsonDocument.Parse(e.Payload).RootElement.Clone());
}
