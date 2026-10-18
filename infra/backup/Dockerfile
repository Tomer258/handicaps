# Backup/restore job: pg_dump (matching server major), age encryption, rclone for the off-host copy.
FROM postgres:18-alpine
RUN apk add --no-cache age=1.3.2-r1 rclone=1.74.1-r3
COPY backup.sh restore.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/backup.sh /usr/local/bin/restore.sh
ENTRYPOINT ["/usr/local/bin/backup.sh"]
