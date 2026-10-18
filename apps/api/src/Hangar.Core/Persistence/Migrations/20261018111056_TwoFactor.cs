using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Hangar.Core.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class TwoFactor : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string[]>(
                name: "recovery_code_hashes",
                table: "users",
                type: "text[]",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "totp_last_step",
                table: "users",
                type: "bigint",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "totp_secret",
                table: "users",
                type: "character varying(512)",
                maxLength: 512,
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "two_factor_enabled_at",
                table: "users",
                type: "timestamp with time zone",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "recovery_code_hashes",
                table: "users");

            migrationBuilder.DropColumn(
                name: "totp_last_step",
                table: "users");

            migrationBuilder.DropColumn(
                name: "totp_secret",
                table: "users");

            migrationBuilder.DropColumn(
                name: "two_factor_enabled_at",
                table: "users");
        }
    }
}
