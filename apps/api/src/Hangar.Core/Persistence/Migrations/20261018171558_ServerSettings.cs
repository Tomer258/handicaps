using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Hangar.Core.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ServerSettings : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "icon_asset_id",
                table: "servers",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "join_message_channel_id",
                table: "servers",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "join_messages_off",
                table: "servers",
                type: "boolean",
                nullable: false,
                defaultValue: false);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "icon_asset_id",
                table: "servers");

            migrationBuilder.DropColumn(
                name: "join_message_channel_id",
                table: "servers");

            migrationBuilder.DropColumn(
                name: "join_messages_off",
                table: "servers");
        }
    }
}
