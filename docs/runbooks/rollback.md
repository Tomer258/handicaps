# Rollback

Images are tagged per release (`HANGAR_VERSION`). Migrations only go forward, so a rollback is safe only to a release
whose code understands the current schema.

1. Decide which path applies. If the bad release added a migration, check its notes for "rollback-compatible".
   If it is not compatible, restore the pre-release backup instead (backup-restore.md); data written since then is
   lost.
2. Compatible rollback:

   ```sh
   cd /opt/hangar && git checkout <previous-tag>
   # set HANGAR_VERSION=<previous-tag> in /srv/hangar/config/hangar.env
   dc up -d api edge sound-publisher asset-validator   # the previous images are still on the host
   ```

3. Verify as in deploy.md §3. Voice calls survive an API or edge rollback: existing media continues, and new joins
   wait for the API.
4. Write down what happened and which commit is bad before retrying.
