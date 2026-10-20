#!/usr/bin/env bash
# Encrypted off-site backup of the Lifeline database and uploaded files.
#
#   1. pg_dump of the database (custom format, includes PostGIS data)
#   2. tar of STORAGE_DIR (documents, prescriptions, photos)
#   3. both encrypted with `age` to BACKUP_AGE_RECIPIENT (a public key; the
#      private key is kept OFF the server, so the VPS can't read old backups)
#   4. uploaded with `rclone` to BACKUP_REMOTE (e.g. Backblaze B2, S3, Drive)
#   5. local copies older than BACKUP_KEEP_DAYS are deleted
#
# Needs: pg_dump, tar, age, rclone. Reads settings from the API's .env.
# Cron (daily at 02:30):
#   30 2 * * * /srv/lifeline-api/scripts/backup.sh >> /var/log/lifeline-backup.log 2>&1
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
set -a
# shellcheck disable=SC1091
source "$APP_DIR/.env"
set +a

: "${DATABASE_URL:?DATABASE_URL is not set}"
: "${BACKUP_AGE_RECIPIENT:?Set BACKUP_AGE_RECIPIENT (age public key, age1...) in .env}"
: "${BACKUP_REMOTE:?Set BACKUP_REMOTE (rclone destination, e.g. b2:lifeline-backups) in .env}"
STORAGE_DIR="${STORAGE_DIR:-./storage}"
case "$STORAGE_DIR" in /*) ;; *) STORAGE_DIR="$APP_DIR/$STORAGE_DIR" ;; esac
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
umask 077
mkdir -p "$BACKUP_DIR"

echo "[$stamp] dumping database"
# Prisma-style ?schema= parameters are not understood by pg_dump
pg_dump --format=custom --no-owner --dbname="${DATABASE_URL%%\?*}" --file="$work/db.dump"

echo "[$stamp] archiving files"
tar -C "$(dirname "$STORAGE_DIR")" -cf "$work/storage.tar" "$(basename "$STORAGE_DIR")"

echo "[$stamp] encrypting"
out="$BACKUP_DIR/lifeline-$stamp.tar.age"
tar -C "$work" -cf - db.dump storage.tar | age --recipient "$BACKUP_AGE_RECIPIENT" --output "$out"
sha256sum "$out" > "$out.sha256"

echo "[$stamp] uploading to $BACKUP_REMOTE"
rclone copy "$out" "$BACKUP_REMOTE/"
rclone copy "$out.sha256" "$BACKUP_REMOTE/"

find "$BACKUP_DIR" -name 'lifeline-*.tar.age*' -mtime +"$KEEP_DAYS" -delete
echo "[$stamp] done: $(du -h "$out" | cut -f1)"
