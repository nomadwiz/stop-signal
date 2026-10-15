#!/usr/bin/env bash
# Packs what the hail service's host runs into one archive (#50): the service's source and the two packages it
# imports, which Node runs with their types stripped, as main.test.ts does; its production dependencies; and the
# built console, which Caddy serves (ADR-015 decision 2). Holds no AWS credentials, so ci.yml runs it in a step
# apart from the upload.
#
# Usage: infra/service-pack.sh <archive.tgz>   from the build repository's root, after npm ci.
#   Then infra/service-upload.sh puts the archive in S3.
set -euo pipefail
out=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
T=$(mktemp -d)
chmod 755 "$T" # the archive's top folder becomes the host's service folder, which the service must read
trap 'rm -rf "$T"' EXIT

npm run build -w @stopsignal/console --silent >/dev/null
# npm ci reads every workspace's package.json against the lock file, so each is copied, though only three
# packages' source is.
cp package.json package-lock.json "$T/"
for p in packages/*/; do mkdir -p "$T/$p"; cp "$p/package.json" "$T/$p"; done
for p in hail-core feed-capture hail-service; do cp -R "packages/$p/src" "$T/packages/$p/"; done
cp -R packages/console/dist "$T/console"
(cd "$T" && npm ci --omit=dev -w @stopsignal/hail-service --ignore-scripts --no-audit --no-fund --loglevel=error)
# Tests are left out, so a change to a test alone restarts nothing on the host. COPYFILE_DISABLE keeps macOS's tar
# from adding a ._ file beside each file that carries extended attributes, and --no-xattrs from adding them as
# headers GNU tar warns of.
COPYFILE_DISABLE=1 tar -czf "$out" --no-xattrs --exclude '*.test.ts' -C "$T" .
