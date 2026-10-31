using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Hangar.Core.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class DirectMessages : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_channels_type",
                table: "channels");

            migrationBuilder.AddColumn<string>(
                name: "dm_key",
                table: "channels",
                type: "character varying(73)",
                maxLength: 73,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "channel_members",
                columns: table => new
                {
                    channel_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    added_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_channel_members", x => new { x.channel_id, x.user_id });
                    table.ForeignKey(
                        name: "fk_channel_members_channels_channel_id",
                        column: x => x.channel_id,
                        principalTable: "channels",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_channel_members_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_channels_dm_key",
                table: "channels",
                column: "dm_key",
                unique: true,
                filter: "dm_key IS NOT NULL");

            migrationBuilder.AddCheckConstraint(
                name: "ck_channels_dm_key",
                table: "channels",
                sql: "(type = 2) = (dm_key IS NOT NULL)");

            migrationBuilder.AddCheckConstraint(
                name: "ck_channels_type",
                table: "channels",
                sql: "type IN (0, 1, 2, 3)");

            migrationBuilder.CreateIndex(
                name: "ix_channel_members_user_id",
                table: "channel_members",
                column: "user_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "channel_members");

            migrationBuilder.DropIndex(
                name: "ix_channels_dm_key",
                table: "channels");

            migrationBuilder.DropCheckConstraint(
                name: "ck_channels_dm_key",
                table: "channels");

            migrationBuilder.DropCheckConstraint(
                name: "ck_channels_type",
                table: "channels");

            migrationBuilder.DropColumn(
                name: "dm_key",
                table: "channels");

            migrationBuilder.AddCheckConstraint(
                name: "ck_channels_type",
                table: "channels",
                sql: "type IN (0, 1)");
        }
    }
}
