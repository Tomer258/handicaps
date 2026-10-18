# Rollback

Images are tagged per release (`HANGAR_VERSION`). Migrations only go forward, so a rollback is safe only to a release
whose code understands the current schema.

## The rule that keeps rollbacks possible

Every migration is **expand-only** unless it says otherwise: new tables, new nullable columns or columns with a
database default, new indexes. Removing, renaming or narrowing something happens in two releases: release N stops
using it, release N+1 drops it. Then the previous release always works against the new schema.

CI enforces this with `infra/scripts/check-migrations.py`. It fails on `DropTable`, `DropColumn`, `Rename*`,
`AlterColumn`, a NOT NULL `AddColumn` without a default, and raw SQL that drops, renames or sets NOT NULL. A
migration that has to break the rule must carry `// rollback-incompatible: <why>`. The lint then lists it, and the
release notes must say "rollback = restore the pre-release backup".

Drill (2026-10-18): the API from `21fcf28`, before `MemberVoiceMute`, ran against the migrated dev database (all
three migrations applied). It started cleanly, and the chat, soundboard, voice-panel and attachments smokes passed
with no server errors.

## Steps

1. Decide which path applies. Run `python -I infra/scripts/check-migrations.py` on the bad release's commit, or check
   its release notes. If any migration since the previous tag is marked `rollback-incompatible`, restore the
   pre-release backup instead (backup-restore.md). Data written since then is lost.
2. Compatible rollback:

   ```sh
   cd /opt/hangar && git checkout <previous-tag>
   # set HANGAR_VERSION=<previous-tag> in /srv/hangar/config/hangar.env
   dc up -d api edge sound-publisher asset-validator   # the previous images are still on the host
   ```

   The older API finds migrations it doesn't know about in `__ef_migrations_history`, has nothing pending, and
   starts normally. Never run `dotnet ef database update <older>`: the Down() methods drop data.
3. Verify as in deploy.md §3. Voice calls survive an API or edge rollback: existing media continues, and new joins
   wait for the API.
4. Write down what happened and which commit is bad before retrying.
