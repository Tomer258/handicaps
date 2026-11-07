using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Hangar.Core.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class DmPerHangar : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_channels_dm_key",
                table: "channels");

            migrationBuilder.CreateIndex(
                name: "ix_channels_server_id_dm_key",
                table: "channels",
                columns: new[] { "server_id", "dm_key" },
                unique: true,
                filter: "dm_key IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_channels_server_id_dm_key",
                table: "channels");

            migrationBuilder.CreateIndex(
                name: "ix_channels_dm_key",
                table: "channels",
                column: "dm_key",
                unique: true,
                filter: "dm_key IS NOT NULL");
        }
    }
}
