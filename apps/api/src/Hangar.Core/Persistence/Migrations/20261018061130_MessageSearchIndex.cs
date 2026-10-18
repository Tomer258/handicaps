using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Hangar.Core.Persistence.Migrations
{
    /// <summary>
    /// Trigram index for server message search (ILIKE '%term%'). pg_trgm is a trusted extension (PostgreSQL ≥ 13),
    /// so the database owner can create it without superuser rights. Tombstones are never searched.
    /// </summary>
    public partial class MessageSearchIndex : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
            migrationBuilder.Sql(
                "CREATE INDEX IF NOT EXISTS ix_messages_body_trgm ON messages USING gin (body gin_trgm_ops) WHERE deleted_at IS NULL;");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("DROP INDEX IF EXISTS ix_messages_body_trgm;");
        }
    }
}
