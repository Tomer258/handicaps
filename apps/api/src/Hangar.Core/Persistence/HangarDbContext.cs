using Hangar.Core.Audit;
using Hangar.Core.Channels;
using Hangar.Core.Files;
using Hangar.Core.Identity;
using Hangar.Core.Media;
using Hangar.Core.Messaging;
using Hangar.Core.Notifications;
using Hangar.Core.Soundboard;
using Hangar.Core.Users;
using Hangar.Core.Workspaces;
using Microsoft.EntityFrameworkCore;

namespace Hangar.Core.Persistence;

/// <summary>
/// One DbContext for the modular monolith. Modules own their tables by convention:
/// a module mutates another module's data only through that module's service.
/// </summary>
public sealed class HangarDbContext(DbContextOptions<HangarDbContext> options) : DbContext(options)
{
    public DbSet<User> Users => Set<User>();
    public DbSet<UserSession> UserSessions => Set<UserSession>();
    public DbSet<Invitation> Invitations => Set<Invitation>();
    public DbSet<Server> Servers => Set<Server>();
    public DbSet<ServerMember> ServerMembers => Set<ServerMember>();
    public DbSet<Role> Roles => Set<Role>();
    public DbSet<MemberRole> MemberRoles => Set<MemberRole>();
    public DbSet<Channel> Channels => Set<Channel>();
    public DbSet<ChannelPermission> ChannelPermissions => Set<ChannelPermission>();
    public DbSet<Message> Messages => Set<Message>();
    public DbSet<MessageReaction> MessageReactions => Set<MessageReaction>();
    public DbSet<MessageAttachment> MessageAttachments => Set<MessageAttachment>();
    public DbSet<MessageMention> MessageMentions => Set<MessageMention>();
    public DbSet<ChannelReadPosition> ChannelReadPositions => Set<ChannelReadPosition>();
    public DbSet<ChannelEvent> ChannelEvents => Set<ChannelEvent>();
    public DbSet<Notification> Notifications => Set<Notification>();
    public DbSet<UserSettings> UserSettings => Set<UserSettings>();
    public DbSet<AuditEvent> AuditEvents => Set<AuditEvent>();
    public DbSet<FileAsset> FileAssets => Set<FileAsset>();
    public DbSet<VoiceLease> VoiceLeases => Set<VoiceLease>();
    public DbSet<MediaPublicationReservation> MediaPublicationReservations => Set<MediaPublicationReservation>();
    public DbSet<SoundboardSound> SoundboardSounds => Set<SoundboardSound>();
    public DbSet<SoundAssetVersion> SoundAssetVersions => Set<SoundAssetVersion>();
    public DbSet<SoundboardFavorite> SoundboardFavorites => Set<SoundboardFavorite>();
    public DbSet<SoundPlaybackCommand> SoundPlaybackCommands => Set<SoundPlaybackCommand>();
    public DbSet<AssetValidationJob> AssetValidationJobs => Set<AssetValidationJob>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        // ---- Identity ----
        b.Entity<User>(e =>
        {
            e.HasIndex(x => x.NormalizedLogin).IsUnique();
            e.HasIndex(x => x.AvatarAssetId);
            e.Property(x => x.Login).HasMaxLength(32);
            e.Property(x => x.NormalizedLogin).HasMaxLength(32);
            e.Property(x => x.DisplayName).HasMaxLength(32);
            e.Property(x => x.PasswordHash).HasMaxLength(512);
            e.Property(x => x.TotpSecret).HasMaxLength(512);
        });
        b.Entity<UserSession>(e =>
        {
            e.HasIndex(x => new { x.UserId, x.RevokedAt });
            e.HasIndex(x => x.AbsoluteExpiresAt);
            e.Property(x => x.DeviceLabel).HasMaxLength(120);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<Invitation>(e =>
        {
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.HasIndex(x => new { x.ServerId, x.ExpiresAt });
            e.Property(x => x.TokenHash).HasMaxLength(128);
            e.Property(x => x.Note).HasMaxLength(120);
            e.ToTable(t => t.HasCheckConstraint("ck_invitations_used_count", "used_count >= 0 AND used_count <= max_uses"));
            e.HasOne<Server>().WithMany().HasForeignKey(x => x.ServerId).OnDelete(DeleteBehavior.Cascade);
        });

        // ---- Workspaces ----
        b.Entity<Server>(e =>
        {
            e.Property(x => x.Name).HasMaxLength(64);
            e.Property(x => x.Version).IsRowVersion();
            e.HasOne<User>().WithMany().HasForeignKey(x => x.OwnerUserId).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<ServerMember>(e =>
        {
            e.HasKey(x => new { x.ServerId, x.UserId });
            e.HasIndex(x => new { x.UserId, x.ServerId });
            e.HasOne<Server>().WithMany().HasForeignKey(x => x.ServerId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<Role>(e =>
        {
            e.HasIndex(x => new { x.ServerId, x.Name }).IsUnique();
            e.HasAlternateKey(x => new { x.ServerId, x.Id });
            e.Property(x => x.Name).HasMaxLength(32);
            e.Property(x => x.Color).HasMaxLength(16);
            e.HasOne<Server>().WithMany().HasForeignKey(x => x.ServerId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<MemberRole>(e =>
        {
            e.HasKey(x => new { x.ServerId, x.UserId, x.RoleId });
            // Composite FKs enforce same-server membership and role.
            e.HasOne<ServerMember>().WithMany().HasForeignKey(x => new { x.ServerId, x.UserId }).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Role>().WithMany().HasForeignKey(x => new { x.ServerId, x.RoleId })
                .HasPrincipalKey(r => new { r.ServerId, r.Id }).OnDelete(DeleteBehavior.Cascade);
        });

        // ---- Channels ----
        b.Entity<Channel>(e =>
        {
            e.HasAlternateKey(x => new { x.ServerId, x.Id });
            e.HasIndex(x => new { x.ServerId, x.Position });
            e.Property(x => x.Name).HasMaxLength(48);
            e.Property(x => x.Topic).HasMaxLength(240);
            e.Property(x => x.Version).IsRowVersion();
            e.ToTable(t => t.HasCheckConstraint("ck_channels_type", "type IN (0, 1)"));
            e.HasOne<Server>().WithMany().HasForeignKey(x => x.ServerId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<ChannelPermission>(e =>
        {
            e.HasIndex(x => new { x.ChannelId, x.RoleId }).IsUnique().HasFilter("role_id IS NOT NULL");
            e.HasIndex(x => new { x.ChannelId, x.MemberUserId }).IsUnique().HasFilter("member_user_id IS NOT NULL");
            e.ToTable(t =>
            {
                t.HasCheckConstraint("ck_channel_permissions_one_subject", "(role_id IS NULL) <> (member_user_id IS NULL)");
                t.HasCheckConstraint("ck_channel_permissions_no_overlap", "(allow_mask & deny_mask) = 0");
            });
            e.HasOne<Channel>().WithMany().HasForeignKey(x => new { x.ServerId, x.ChannelId })
                .HasPrincipalKey(c => new { c.ServerId, c.Id }).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Role>().WithMany().HasForeignKey(x => new { x.ServerId, x.RoleId })
                .HasPrincipalKey(r => new { r.ServerId, r.Id }).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<ServerMember>().WithMany().HasForeignKey(x => new { x.ServerId, x.MemberUserId }).OnDelete(DeleteBehavior.Cascade);
        });

        // ---- Messaging ----
        b.Entity<Message>(e =>
        {
            e.HasAlternateKey(x => new { x.ChannelId, x.Id });
            e.HasIndex(x => new { x.ChannelId, x.MessageSequence }).IsUnique().IsDescending(false, true);
            e.HasIndex(x => new { x.AuthorUserId, x.ClientMessageId }).IsUnique();
            e.HasIndex(x => x.ReplyToId);
            e.Property(x => x.Body).HasMaxLength(4000);
            e.HasOne<Channel>().WithMany().HasForeignKey(x => new { x.ServerId, x.ChannelId })
                .HasPrincipalKey(c => new { c.ServerId, c.Id }).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.AuthorUserId).OnDelete(DeleteBehavior.Restrict);
            // Same-channel reply enforced by composite FK (channel_id, reply_to_id) → (channel_id, id).
            e.HasOne<Message>().WithMany().HasForeignKey(x => new { x.ChannelId, x.ReplyToId })
                .HasPrincipalKey(m => new { m.ChannelId, m.Id }).OnDelete(DeleteBehavior.Restrict);
            e.HasMany(x => x.Reactions).WithOne().HasForeignKey(x => x.MessageId).OnDelete(DeleteBehavior.Cascade);
            e.HasMany(x => x.Attachments).WithOne().HasForeignKey(x => x.MessageId).OnDelete(DeleteBehavior.Cascade);
            e.HasMany(x => x.Mentions).WithOne().HasForeignKey(x => x.MessageId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<MessageReaction>(e =>
        {
            e.HasKey(x => new { x.MessageId, x.UserId, x.EmojiKey });
            e.Property(x => x.EmojiKey).HasMaxLength(32);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<MessageAttachment>(e =>
        {
            e.HasKey(x => new { x.MessageId, x.FileAssetId });
            e.HasIndex(x => x.FileAssetId).IsUnique();
            e.HasIndex(x => new { x.MessageId, x.Ordinal });
            e.HasOne<FileAsset>().WithMany().HasForeignKey(x => x.FileAssetId).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<MessageMention>(e =>
        {
            e.HasKey(x => new { x.MessageId, x.MentionedUserId });
            e.HasIndex(x => new { x.MentionedUserId, x.MessageId });
            e.HasOne<User>().WithMany().HasForeignKey(x => x.MentionedUserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<ChannelReadPosition>(e =>
        {
            e.HasKey(x => new { x.UserId, x.ChannelId });
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Channel>().WithMany().HasForeignKey(x => x.ChannelId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<ChannelEvent>(e =>
        {
            e.HasKey(x => x.EventId);
            e.HasIndex(x => new { x.ChannelId, x.EventSequence }).IsUnique();
            e.HasIndex(x => x.CommittedAt).HasFilter("dispatched_at IS NULL").HasDatabaseName("ix_channel_events_undispatched");
            e.HasIndex(x => x.CommittedAt).HasDatabaseName("ix_channel_events_retention");
            e.Property(x => x.Type).HasMaxLength(48);
            e.Property(x => x.Payload).HasColumnType("jsonb");
            e.HasOne<Channel>().WithMany().HasForeignKey(x => x.ChannelId).OnDelete(DeleteBehavior.Cascade);
        });

        // ---- Notifications / users / audit ----
        b.Entity<Notification>(e =>
        {
            e.HasIndex(x => new { x.UserId, x.MessageId, x.Type }).IsUnique();
            e.HasIndex(x => new { x.UserId, x.CreatedAt }).HasFilter("read_at IS NULL").HasDatabaseName("ix_notifications_unread");
            e.Property(x => x.Type).HasMaxLength(24);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Message>().WithMany().HasForeignKey(x => x.MessageId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<UserSettings>(e =>
        {
            e.HasKey(x => x.UserId);
            e.Property(x => x.NotificationPreferences).HasColumnType("jsonb");
            e.Property(x => x.AudioPreferences).HasColumnType("jsonb");
            e.Property(x => x.AppearancePreferences).HasColumnType("jsonb");
            e.HasOne<User>().WithOne().HasForeignKey<UserSettings>(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<AuditEvent>(e =>
        {
            e.HasIndex(x => x.Time);
            e.HasIndex(x => new { x.ActorUserId, x.Time });
            e.Property(x => x.TargetType).HasMaxLength(32);
            e.Property(x => x.TargetId).HasMaxLength(64);
            e.Property(x => x.Action).HasMaxLength(64);
            e.Property(x => x.Outcome).HasMaxLength(16);
            e.Property(x => x.RedactedDetail).HasMaxLength(500);
        });

        // ---- Files ----
        b.Entity<FileAsset>(e =>
        {
            e.HasIndex(x => x.StorageKey).IsUnique();
            e.HasIndex(x => new { x.ServerId, x.State });
            e.Property(x => x.StorageKey).HasMaxLength(80);
            e.Property(x => x.Mime).HasMaxLength(100);
            e.Property(x => x.OriginalName).HasMaxLength(200);
            e.Property(x => x.Sha256).HasMaxLength(64);
            e.ToTable(t => t.HasCheckConstraint("ck_file_assets_size", "size_bytes >= 0"));
        });

        // ---- Media ----
        b.Entity<VoiceLease>(e =>
        {
            // At most one joining/active lease per user, enforced by the database.
            e.HasIndex(x => x.UserId).IsUnique().HasFilter("status IN (0, 1)").HasDatabaseName("ux_voice_leases_one_active");
            e.HasIndex(x => new { x.ChannelId, x.Status });
            e.HasIndex(x => new { x.UserId, x.RequestId }).IsUnique();
            e.HasIndex(x => x.SessionId);
            e.Property(x => x.RoomName).HasMaxLength(80);
            e.Property(x => x.EndReason).HasMaxLength(48);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Channel>().WithMany().HasForeignKey(x => x.ChannelId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<MediaPublicationReservation>(e =>
        {
            e.HasIndex(x => new { x.VoiceLeaseId, x.Kind }).IsUnique().HasFilter("state = 0");
            e.HasIndex(x => x.ExpiresAt);
            e.Property(x => x.Quality).HasMaxLength(16);
            e.HasOne<VoiceLease>().WithMany().HasForeignKey(x => x.VoiceLeaseId).OnDelete(DeleteBehavior.Cascade);
        });

        // ---- Soundboard ----
        b.Entity<SoundboardSound>(e =>
        {
            e.HasIndex(x => new { x.ServerId, x.State, x.Name });
            e.Property(x => x.Name).HasMaxLength(60);
            e.Property(x => x.Emoji).HasMaxLength(16);
            e.Property(x => x.RejectReason).HasMaxLength(64);
            e.Property(x => x.Version).IsRowVersion();
            e.ToTable(t => t.HasCheckConstraint("ck_sounds_ready_duration", "state <> 1 OR (duration_ms BETWEEN 100 AND 5000)"));
            e.HasOne<Server>().WithMany().HasForeignKey(x => x.ServerId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.OwnerUserId).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<SoundAssetVersion>(e =>
        {
            e.HasIndex(x => new { x.SoundId, x.VersionNumber }).IsUnique();
            e.HasIndex(x => x.FileAssetId).IsUnique();
            e.Property(x => x.Sha256).HasMaxLength(64);
            e.HasOne<SoundboardSound>().WithMany().HasForeignKey(x => x.SoundId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<FileAsset>().WithMany().HasForeignKey(x => x.FileAssetId).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<SoundboardFavorite>(e =>
        {
            e.HasKey(x => new { x.UserId, x.SoundId });
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<SoundboardSound>().WithMany().HasForeignKey(x => x.SoundId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<SoundPlaybackCommand>(e =>
        {
            e.HasIndex(x => new { x.ActorUserId, x.RequestId }).IsUnique();
            e.HasIndex(x => new { x.State, x.StartDeadline });
            e.HasIndex(x => new { x.ChannelId, x.AcceptedAt });
            e.HasIndex(x => x.AcceptedAt);
            e.Property(x => x.RoomName).HasMaxLength(80);
            e.Property(x => x.FailureCode).HasMaxLength(48);
        });
        b.Entity<AssetValidationJob>(e =>
        {
            e.HasIndex(x => new { x.AssetId, x.JobType }).IsUnique().HasFilter("state IN (0, 1)");
            e.HasIndex(x => new { x.State, x.CreatedAt });
            e.Property(x => x.JobType).HasMaxLength(32);
            e.Property(x => x.ResultHash).HasMaxLength(64);
            e.Property(x => x.ErrorCode).HasMaxLength(64);
            e.HasOne<FileAsset>().WithMany().HasForeignKey(x => x.AssetId).OnDelete(DeleteBehavior.Cascade);
        });
    }
}
