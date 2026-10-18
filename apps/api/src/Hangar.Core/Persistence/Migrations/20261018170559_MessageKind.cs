using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Hangar.Core.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class MessageKind : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "kind",
                table: "messages",
                type: "integer",
                nullable: false,
                defaultValue: 0);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "kind",
                table: "messages");
        }
    }
}
