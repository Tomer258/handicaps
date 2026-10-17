using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Hangar.Core.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class Initial : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "audit_events",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    actor_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    target_type = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    target_id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    action = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    time = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    outcome = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    redacted_detail = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_audit_events", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "file_assets",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    server_id = table.Column<Guid>(type: "uuid", nullable: false),
                    owner_user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    purpose = table.Column<int>(type: "integer", nullable: false),
                    storage_key = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    mime = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    original_name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    size_bytes = table.Column<long>(type: "bigint", nullable: false),
                    sha256 = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    width = table.Column<int>(type: "integer", nullable: true),
                    height = table.Column<int>(type: "integer", nullable: true),
                    state = table.Column<int>(type: "integer", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_file_assets", x => x.id);
                    table.CheckConstraint("ck_file_assets_size", "size_bytes >= 0");
                });

            migrationBuilder.CreateTable(
                name: "sound_playback_commands",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    request_id = table.Column<Guid>(type: "uuid", nullable: false),
                    server_id = table.Column<Guid>(type: "uuid", nullable: false),
                    channel_id = table.Column<Guid>(type: "uuid", nullable: false),
                    room_name = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    room_generation = table.Column<long>(type: "bigint", nullable: false),
                    voice_lease_id = table.Column<Guid>(type: "uuid", nullable: false),
                    actor_user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    sound_id = table.Column<Guid>(type: "uuid", nullable: false),
                    sound_version_id = table.Column<Guid>(type: "uuid", nullable: false),
                    worker_epoch = table.Column<long>(type: "bigint", nullable: false),
                    state = table.Column<int>(type: "integer", nullable: false),
                    duration_ms = table.Column<int>(type: "integer", nullable: false),
                    accepted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    start_deadline = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    started_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    ended_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    stopped_by = table.Column<Guid>(type: "uuid", nullable: true),
                    failure_code = table.Column<string>(type: "character varying(48)", maxLength: 48, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_sound_playback_commands", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "users",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    login = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    normalized_login = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    password_hash = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: false),
                    display_name = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    avatar_asset_id = table.Column<Guid>(type: "uuid", nullable: true),
                    avatar_hue = table.Column<int>(type: "integer", nullable: false),
                    disabled_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    security_version = table.Column<int>(type: "integer", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_users", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "asset_validation_jobs",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    asset_id = table.Column<Guid>(type: "uuid", nullable: false),
                    sound_id = table.Column<Guid>(type: "uuid", nullable: false),
                    job_type = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    state = table.Column<int>(type: "integer", nullable: false),
                    attempt = table.Column<int>(type: "integer", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    lease_expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    result_hash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    error_code = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    trim_start_seconds = table.Column<double>(type: "double precision", nullable: true),
                    trim_end_seconds = table.Column<double>(type: "double precision", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_asset_validation_jobs", x => x.id);
                    table.ForeignKey(
                        name: "fk_asset_validation_jobs_file_assets_asset_id",
                        column: x => x.asset_id,
                        principalTable: "file_assets",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "servers",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    owner_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    policy_version = table.Column<long>(type: "bigint", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_servers", x => x.id);
                    table.ForeignKey(
                        name: "fk_servers_users_owner_user_id",
                        column: x => x.owner_user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "user_sessions",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    last_seen_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    idle_expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    absolute_expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    revoked_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    security_version = table.Column<int>(type: "integer", nullable: false),
                    persistent = table.Column<bool>(type: "boolean", nullable: false),
                    device_label = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_sessions", x => x.id);
                    table.ForeignKey(
                        name: "fk_user_sessions_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "user_settings",
                columns: table => new
                {
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    preferred_status = table.Column<int>(type: "integer", nullable: false),
                    notification_preferences = table.Column<string>(type: "jsonb", nullable: false),
                    audio_preferences = table.Column<string>(type: "jsonb", nullable: false),
                    appearance_preferences = table.Column<string>(type: "jsonb", nullable: false),
                    version = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_user_settings", x => x.user_id);
                    table.ForeignKey(
                        name: "fk_user_settings_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "channels",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    server_id = table.Column<Guid>(type: "uuid", nullable: false),
                    type = table.Column<int>(type: "integer", nullable: false),
                    name = table.Column<string>(type: "character varying(48)", maxLength: 48, nullable: false),
                    topic = table.Column<string>(type: "character varying(240)", maxLength: 240, nullable: true),
                    position = table.Column<int>(type: "integer", nullable: false),
                    archived_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    next_message_sequence = table.Column<long>(type: "bigint", nullable: false),
                    next_event_sequence = table.Column<long>(type: "bigint", nullable: false),
                    policy_version = table.Column<long>(type: "bigint", nullable: false),
                    media_generation = table.Column<long>(type: "bigint", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_channels", x => x.id);
                    table.UniqueConstraint("ak_channels_server_id_id", x => new { x.server_id, x.id });
                    table.CheckConstraint("ck_channels_type", "type IN (0, 1)");
                    table.ForeignKey(
                        name: "fk_channels_servers_server_id",
                        column: x => x.server_id,
                        principalTable: "servers",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "invitations",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    server_id = table.Column<Guid>(type: "uuid", nullable: false),
                    token_hash = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    purpose = table.Column<int>(type: "integer", nullable: false),
                    created_by = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    max_uses = table.Column<int>(type: "integer", nullable: false),
                    used_count = table.Column<int>(type: "integer", nullable: false),
                    revoked_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    note = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_invitations", x => x.id);
                    table.CheckConstraint("ck_invitations_used_count", "used_count >= 0 AND used_count <= max_uses");
                    table.ForeignKey(
                        name: "fk_invitations_servers_server_id",
                        column: x => x.server_id,
                        principalTable: "servers",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "roles",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    server_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    permission_mask = table.Column<long>(type: "bigint", nullable: false),
                    is_default = table.Column<bool>(type: "boolean", nullable: false),
                    position = table.Column<int>(type: "integer", nullable: false),
                    color = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    hoist = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_roles", x => x.id);
                    table.UniqueConstraint("ak_roles_server_id_id", x => new { x.server_id, x.id });
                    table.ForeignKey(
                        name: "fk_roles_servers_server_id",
                        column: x => x.server_id,
                        principalTable: "servers",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "server_members",
                columns: table => new
                {
                    server_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    joined_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    removed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    member_version = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_server_members", x => new { x.server_id, x.user_id });
                    table.ForeignKey(
                        name: "fk_server_members_servers_server_id",
                        column: x => x.server_id,
                        principalTable: "servers",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_server_members_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "soundboard_sounds",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    server_id = table.Column<Guid>(type: "uuid", nullable: false),
                    owner_user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    emoji = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    duration_ms = table.Column<int>(type: "integer", nullable: false),
                    active_version_id = table.Column<Guid>(type: "uuid", nullable: true),
                    state = table.Column<int>(type: "integer", nullable: false),
                    reject_reason = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_soundboard_sounds", x => x.id);
                    table.CheckConstraint("ck_sounds_ready_duration", "state <> 1 OR (duration_ms BETWEEN 100 AND 5000)");
                    table.ForeignKey(
                        name: "fk_soundboard_sounds_servers_server_id",
                        column: x => x.server_id,
                        principalTable: "servers",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_soundboard_sounds_users_owner_user_id",
                        column: x => x.owner_user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "channel_events",
                columns: table => new
                {
                    event_id = table.Column<Guid>(type: "uuid", nullable: false),
                    server_id = table.Column<Guid>(type: "uuid", nullable: false),
                    channel_id = table.Column<Guid>(type: "uuid", nullable: false),
                    event_sequence = table.Column<long>(type: "bigint", nullable: false),
                    type = table.Column<string>(type: "character varying(48)", maxLength: 48, nullable: false),
                    entity_id = table.Column<Guid>(type: "uuid", nullable: false),
                    entity_version = table.Column<long>(type: "bigint", nullable: false),
                    actor_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    payload = table.Column<string>(type: "jsonb", nullable: false),
                    committed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    dispatched_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    dispatch_attempts = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_channel_events", x => x.event_id);
                    table.ForeignKey(
                        name: "fk_channel_events_channels_channel_id",
                        column: x => x.channel_id,
                        principalTable: "channels",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "channel_read_positions",
                columns: table => new
                {
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    channel_id = table.Column<Guid>(type: "uuid", nullable: false),
                    last_read_message_sequence = table.Column<long>(type: "bigint", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_channel_read_positions", x => new { x.user_id, x.channel_id });
                    table.ForeignKey(
                        name: "fk_channel_read_positions_channels_channel_id",
                        column: x => x.channel_id,
                        principalTable: "channels",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_channel_read_positions_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "messages",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    server_id = table.Column<Guid>(type: "uuid", nullable: false),
                    channel_id = table.Column<Guid>(type: "uuid", nullable: false),
                    author_user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    message_sequence = table.Column<long>(type: "bigint", nullable: false),
                    client_message_id = table.Column<Guid>(type: "uuid", nullable: false),
                    body = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    reply_to_id = table.Column<Guid>(type: "uuid", nullable: true),
                    version = table.Column<long>(type: "bigint", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    edited_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    deleted_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    pinned = table.Column<bool>(type: "boolean", nullable: false),
                    mentions_everyone = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_messages", x => x.id);
                    table.UniqueConstraint("ak_messages_channel_id_id", x => new { x.channel_id, x.id });
                    table.ForeignKey(
                        name: "fk_messages_channels_server_id_channel_id",
                        columns: x => new { x.server_id, x.channel_id },
                        principalTable: "channels",
                        principalColumns: new[] { "server_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_messages_messages_channel_id_reply_to_id",
                        columns: x => new { x.channel_id, x.reply_to_id },
                        principalTable: "messages",
                        principalColumns: new[] { "channel_id", "id" },
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_messages_users_author_user_id",
                        column: x => x.author_user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "voice_leases",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    session_id = table.Column<Guid>(type: "uuid", nullable: false),
                    server_id = table.Column<Guid>(type: "uuid", nullable: false),
                    channel_id = table.Column<Guid>(type: "uuid", nullable: false),
                    room_name = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    room_generation = table.Column<long>(type: "bigint", nullable: false),
                    granted_policy_version = table.Column<long>(type: "bigint", nullable: false),
                    status = table.Column<int>(type: "integer", nullable: false),
                    request_id = table.Column<Guid>(type: "uuid", nullable: false),
                    can_speak = table.Column<bool>(type: "boolean", nullable: false),
                    can_camera = table.Column<bool>(type: "boolean", nullable: false),
                    can_screen = table.Column<bool>(type: "boolean", nullable: false),
                    server_muted = table.Column<bool>(type: "boolean", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    last_confirmed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    revoked_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    end_reason = table.Column<string>(type: "character varying(48)", maxLength: 48, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_voice_leases", x => x.id);
                    table.ForeignKey(
                        name: "fk_voice_leases_channels_channel_id",
                        column: x => x.channel_id,
                        principalTable: "channels",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_voice_leases_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "channel_permissions",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    server_id = table.Column<Guid>(type: "uuid", nullable: false),
                    channel_id = table.Column<Guid>(type: "uuid", nullable: false),
                    role_id = table.Column<Guid>(type: "uuid", nullable: true),
                    member_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    allow_mask = table.Column<long>(type: "bigint", nullable: false),
                    deny_mask = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_channel_permissions", x => x.id);
                    table.CheckConstraint("ck_channel_permissions_no_overlap", "(allow_mask & deny_mask) = 0");
                    table.CheckConstraint("ck_channel_permissions_one_subject", "(role_id IS NULL) <> (member_user_id IS NULL)");
                    table.ForeignKey(
                        name: "fk_channel_permissions_channels_server_id_channel_id",
                        columns: x => new { x.server_id, x.channel_id },
                        principalTable: "channels",
                        principalColumns: new[] { "server_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_channel_permissions_roles_server_id_role_id",
                        columns: x => new { x.server_id, x.role_id },
                        principalTable: "roles",
                        principalColumns: new[] { "server_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_channel_permissions_server_members_server_id_member_user_id",
                        columns: x => new { x.server_id, x.member_user_id },
                        principalTable: "server_members",
                        principalColumns: new[] { "server_id", "user_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "member_roles",
                columns: table => new
                {
                    server_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    role_id = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_member_roles", x => new { x.server_id, x.user_id, x.role_id });
                    table.ForeignKey(
                        name: "fk_member_roles_roles_server_id_role_id",
                        columns: x => new { x.server_id, x.role_id },
                        principalTable: "roles",
                        principalColumns: new[] { "server_id", "id" },
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_member_roles_server_members_server_id_user_id",
                        columns: x => new { x.server_id, x.user_id },
                        principalTable: "server_members",
                        principalColumns: new[] { "server_id", "user_id" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "sound_asset_versions",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    sound_id = table.Column<Guid>(type: "uuid", nullable: false),
                    file_asset_id = table.Column<Guid>(type: "uuid", nullable: false),
                    version_number = table.Column<int>(type: "integer", nullable: false),
                    sha256 = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    sample_rate = table.Column<int>(type: "integer", nullable: false),
                    channels = table.Column<int>(type: "integer", nullable: false),
                    loudness = table.Column<double>(type: "double precision", nullable: true),
                    true_peak = table.Column<double>(type: "double precision", nullable: true),
                    duration_ms = table.Column<int>(type: "integer", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_sound_asset_versions", x => x.id);
                    table.ForeignKey(
                        name: "fk_sound_asset_versions_file_assets_file_asset_id",
                        column: x => x.file_asset_id,
                        principalTable: "file_assets",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_sound_asset_versions_soundboard_sounds_sound_id",
                        column: x => x.sound_id,
                        principalTable: "soundboard_sounds",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "soundboard_favorites",
                columns: table => new
                {
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    sound_id = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_soundboard_favorites", x => new { x.user_id, x.sound_id });
                    table.ForeignKey(
                        name: "fk_soundboard_favorites_soundboard_sounds_sound_id",
                        column: x => x.sound_id,
                        principalTable: "soundboard_sounds",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_soundboard_favorites_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "message_attachments",
                columns: table => new
                {
                    message_id = table.Column<Guid>(type: "uuid", nullable: false),
                    file_asset_id = table.Column<Guid>(type: "uuid", nullable: false),
                    ordinal = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_message_attachments", x => new { x.message_id, x.file_asset_id });
                    table.ForeignKey(
                        name: "fk_message_attachments_file_assets_file_asset_id",
                        column: x => x.file_asset_id,
                        principalTable: "file_assets",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_message_attachments_messages_message_id",
                        column: x => x.message_id,
                        principalTable: "messages",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "message_mentions",
                columns: table => new
                {
                    message_id = table.Column<Guid>(type: "uuid", nullable: false),
                    mentioned_user_id = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_message_mentions", x => new { x.message_id, x.mentioned_user_id });
                    table.ForeignKey(
                        name: "fk_message_mentions_messages_message_id",
                        column: x => x.message_id,
                        principalTable: "messages",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_message_mentions_users_mentioned_user_id",
                        column: x => x.mentioned_user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "message_reactions",
                columns: table => new
                {
                    message_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    emoji_key = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_message_reactions", x => new { x.message_id, x.user_id, x.emoji_key });
                    table.ForeignKey(
                        name: "fk_message_reactions_messages_message_id",
                        column: x => x.message_id,
                        principalTable: "messages",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_message_reactions_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "notifications",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    type = table.Column<string>(type: "character varying(24)", maxLength: 24, nullable: false),
                    message_id = table.Column<Guid>(type: "uuid", nullable: false),
                    channel_id = table.Column<Guid>(type: "uuid", nullable: false),
                    actor_user_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    read_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_notifications", x => x.id);
                    table.ForeignKey(
                        name: "fk_notifications_messages_message_id",
                        column: x => x.message_id,
                        principalTable: "messages",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_notifications_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "media_publication_reservations",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    voice_lease_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    channel_id = table.Column<Guid>(type: "uuid", nullable: false),
                    kind = table.Column<int>(type: "integer", nullable: false),
                    state = table.Column<int>(type: "integer", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    quality = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    with_audio = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_media_publication_reservations", x => x.id);
                    table.ForeignKey(
                        name: "fk_media_publication_reservations_voice_leases_voice_lease_id",
                        column: x => x.voice_lease_id,
                        principalTable: "voice_leases",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_asset_validation_jobs_asset_id_job_type",
                table: "asset_validation_jobs",
                columns: new[] { "asset_id", "job_type" },
                unique: true,
                filter: "state IN (0, 1)");

            migrationBuilder.CreateIndex(
                name: "ix_asset_validation_jobs_state_created_at",
                table: "asset_validation_jobs",
                columns: new[] { "state", "created_at" });

            migrationBuilder.CreateIndex(
                name: "ix_audit_events_actor_user_id_time",
                table: "audit_events",
                columns: new[] { "actor_user_id", "time" });

            migrationBuilder.CreateIndex(
                name: "ix_audit_events_time",
                table: "audit_events",
                column: "time");

            migrationBuilder.CreateIndex(
                name: "ix_channel_events_channel_id_event_sequence",
                table: "channel_events",
                columns: new[] { "channel_id", "event_sequence" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_channel_events_retention",
                table: "channel_events",
                column: "committed_at",
                filter: "dispatched_at IS NULL");

            migrationBuilder.CreateIndex(
                name: "ix_channel_permissions_channel_id_member_user_id",
                table: "channel_permissions",
                columns: new[] { "channel_id", "member_user_id" },
                unique: true,
                filter: "member_user_id IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "ix_channel_permissions_channel_id_role_id",
                table: "channel_permissions",
                columns: new[] { "channel_id", "role_id" },
                unique: true,
                filter: "role_id IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "ix_channel_permissions_server_id_channel_id",
                table: "channel_permissions",
                columns: new[] { "server_id", "channel_id" });

            migrationBuilder.CreateIndex(
                name: "ix_channel_permissions_server_id_member_user_id",
                table: "channel_permissions",
                columns: new[] { "server_id", "member_user_id" });

            migrationBuilder.CreateIndex(
                name: "ix_channel_permissions_server_id_role_id",
                table: "channel_permissions",
                columns: new[] { "server_id", "role_id" });

            migrationBuilder.CreateIndex(
                name: "ix_channel_read_positions_channel_id",
                table: "channel_read_positions",
                column: "channel_id");

            migrationBuilder.CreateIndex(
                name: "ix_channels_server_id_position",
                table: "channels",
                columns: new[] { "server_id", "position" });

            migrationBuilder.CreateIndex(
                name: "ix_file_assets_server_id_state",
                table: "file_assets",
                columns: new[] { "server_id", "state" });

            migrationBuilder.CreateIndex(
                name: "ix_file_assets_storage_key",
                table: "file_assets",
                column: "storage_key",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_invitations_server_id_expires_at",
                table: "invitations",
                columns: new[] { "server_id", "expires_at" });

            migrationBuilder.CreateIndex(
                name: "ix_invitations_token_hash",
                table: "invitations",
                column: "token_hash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_media_publication_reservations_expires_at",
                table: "media_publication_reservations",
                column: "expires_at");

            migrationBuilder.CreateIndex(
                name: "ix_media_publication_reservations_voice_lease_id_kind",
                table: "media_publication_reservations",
                columns: new[] { "voice_lease_id", "kind" },
                unique: true,
                filter: "state = 0");

            migrationBuilder.CreateIndex(
                name: "ix_member_roles_server_id_role_id",
                table: "member_roles",
                columns: new[] { "server_id", "role_id" });

            migrationBuilder.CreateIndex(
                name: "ix_message_attachments_file_asset_id",
                table: "message_attachments",
                column: "file_asset_id",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_message_attachments_message_id_ordinal",
                table: "message_attachments",
                columns: new[] { "message_id", "ordinal" });

            migrationBuilder.CreateIndex(
                name: "ix_message_mentions_mentioned_user_id_message_id",
                table: "message_mentions",
                columns: new[] { "mentioned_user_id", "message_id" });

            migrationBuilder.CreateIndex(
                name: "ix_message_reactions_user_id",
                table: "message_reactions",
                column: "user_id");

            migrationBuilder.CreateIndex(
                name: "ix_messages_author_user_id_client_message_id",
                table: "messages",
                columns: new[] { "author_user_id", "client_message_id" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_messages_channel_id_message_sequence",
                table: "messages",
                columns: new[] { "channel_id", "message_sequence" },
                unique: true,
                descending: new[] { false, true });

            migrationBuilder.CreateIndex(
                name: "ix_messages_channel_id_reply_to_id",
                table: "messages",
                columns: new[] { "channel_id", "reply_to_id" });

            migrationBuilder.CreateIndex(
                name: "ix_messages_reply_to_id",
                table: "messages",
                column: "reply_to_id");

            migrationBuilder.CreateIndex(
                name: "ix_messages_server_id_channel_id",
                table: "messages",
                columns: new[] { "server_id", "channel_id" });

            migrationBuilder.CreateIndex(
                name: "ix_notifications_message_id",
                table: "notifications",
                column: "message_id");

            migrationBuilder.CreateIndex(
                name: "ix_notifications_unread",
                table: "notifications",
                columns: new[] { "user_id", "created_at" },
                filter: "read_at IS NULL");

            migrationBuilder.CreateIndex(
                name: "ix_notifications_user_id_message_id_type",
                table: "notifications",
                columns: new[] { "user_id", "message_id", "type" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_roles_server_id_name",
                table: "roles",
                columns: new[] { "server_id", "name" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_server_members_user_id_server_id",
                table: "server_members",
                columns: new[] { "user_id", "server_id" });

            migrationBuilder.CreateIndex(
                name: "ix_servers_owner_user_id",
                table: "servers",
                column: "owner_user_id");

            migrationBuilder.CreateIndex(
                name: "ix_sound_asset_versions_file_asset_id",
                table: "sound_asset_versions",
                column: "file_asset_id",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_sound_asset_versions_sound_id_version_number",
                table: "sound_asset_versions",
                columns: new[] { "sound_id", "version_number" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_sound_playback_commands_accepted_at",
                table: "sound_playback_commands",
                column: "accepted_at");

            migrationBuilder.CreateIndex(
                name: "ix_sound_playback_commands_actor_user_id_request_id",
                table: "sound_playback_commands",
                columns: new[] { "actor_user_id", "request_id" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_sound_playback_commands_channel_id_accepted_at",
                table: "sound_playback_commands",
                columns: new[] { "channel_id", "accepted_at" });

            migrationBuilder.CreateIndex(
                name: "ix_sound_playback_commands_state_start_deadline",
                table: "sound_playback_commands",
                columns: new[] { "state", "start_deadline" });

            migrationBuilder.CreateIndex(
                name: "ix_soundboard_favorites_sound_id",
                table: "soundboard_favorites",
                column: "sound_id");

            migrationBuilder.CreateIndex(
                name: "ix_soundboard_sounds_owner_user_id",
                table: "soundboard_sounds",
                column: "owner_user_id");

            migrationBuilder.CreateIndex(
                name: "ix_soundboard_sounds_server_id_state_name",
                table: "soundboard_sounds",
                columns: new[] { "server_id", "state", "name" });

            migrationBuilder.CreateIndex(
                name: "ix_user_sessions_absolute_expires_at",
                table: "user_sessions",
                column: "absolute_expires_at");

            migrationBuilder.CreateIndex(
                name: "ix_user_sessions_user_id_revoked_at",
                table: "user_sessions",
                columns: new[] { "user_id", "revoked_at" });

            migrationBuilder.CreateIndex(
                name: "ix_users_avatar_asset_id",
                table: "users",
                column: "avatar_asset_id");

            migrationBuilder.CreateIndex(
                name: "ix_users_normalized_login",
                table: "users",
                column: "normalized_login",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_voice_leases_channel_id_status",
                table: "voice_leases",
                columns: new[] { "channel_id", "status" });

            migrationBuilder.CreateIndex(
                name: "ix_voice_leases_session_id",
                table: "voice_leases",
                column: "session_id");

            migrationBuilder.CreateIndex(
                name: "ix_voice_leases_user_id_request_id",
                table: "voice_leases",
                columns: new[] { "user_id", "request_id" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ux_voice_leases_one_active",
                table: "voice_leases",
                column: "user_id",
                unique: true,
                filter: "status IN (0, 1)");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "asset_validation_jobs");

            migrationBuilder.DropTable(
                name: "audit_events");

            migrationBuilder.DropTable(
                name: "channel_events");

            migrationBuilder.DropTable(
                name: "channel_permissions");

            migrationBuilder.DropTable(
                name: "channel_read_positions");

            migrationBuilder.DropTable(
                name: "invitations");

            migrationBuilder.DropTable(
                name: "media_publication_reservations");

            migrationBuilder.DropTable(
                name: "member_roles");

            migrationBuilder.DropTable(
                name: "message_attachments");

            migrationBuilder.DropTable(
                name: "message_mentions");

            migrationBuilder.DropTable(
                name: "message_reactions");

            migrationBuilder.DropTable(
                name: "notifications");

            migrationBuilder.DropTable(
                name: "sound_asset_versions");

            migrationBuilder.DropTable(
                name: "sound_playback_commands");

            migrationBuilder.DropTable(
                name: "soundboard_favorites");

            migrationBuilder.DropTable(
                name: "user_sessions");

            migrationBuilder.DropTable(
                name: "user_settings");

            migrationBuilder.DropTable(
                name: "voice_leases");

            migrationBuilder.DropTable(
                name: "roles");

            migrationBuilder.DropTable(
                name: "server_members");

            migrationBuilder.DropTable(
                name: "messages");

            migrationBuilder.DropTable(
                name: "file_assets");

            migrationBuilder.DropTable(
                name: "soundboard_sounds");

            migrationBuilder.DropTable(
                name: "channels");

            migrationBuilder.DropTable(
                name: "servers");

            migrationBuilder.DropTable(
                name: "users");
        }
    }
}
