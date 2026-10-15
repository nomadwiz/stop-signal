#!/usr/bin/env bash
# Uploads the hail service's archive to s3://<bucket>/deploy/service/service.tgz, and keeps Auckland Transport's
# static timetable beside it as gtfs.zip: fetched only when that object is absent, so every later deploy loads
# the same file (ADR-043, annotated 11-10-2026). Deleting the object makes the next run fetch the current one;
# cut ios/StopSignal/stops.json from it again and rebuild the app.
#
# Usage: infra/service-upload.sh <bucket> <archive.tgz>   with AWS credentials set; infra/service-pack.sh makes the
#   archive. ci.yml's deploy job and infra/service-host.sh run it.
set -euo pipefail
BUCKET=$1
aws s3 cp "$2" "s3://$BUCKET/deploy/service/service.tgz" --only-show-errors
# An assignment, so set -e stops here if the lookup fails, rather than fetching over a kept timetable.
kept=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix deploy/service/gtfs.zip --query 'Contents[0].Key' --output text)
if [ "$kept" != deploy/service/gtfs.zip ]; then
  T=$(mktemp -d)
  trap 'rm -rf "$T"' EXIT
  # packages/hail-service/src/gtfs-static.ts's GTFS_URL.
  curl -fsSL -o "$T/gtfs.zip" https://gtfs.at.govt.nz/gtfs.zip
  # The kept file outlives this run, so a download that is not a timetable never becomes it.
  unzip -l "$T/gtfs.zip" stops.txt stop_times.txt trips.txt >/dev/null
  aws s3 cp "$T/gtfs.zip" "s3://$BUCKET/deploy/service/gtfs.zip" --only-show-errors
  echo "fetched Auckland Transport's timetable into s3://$BUCKET/deploy/service/gtfs.zip"
fi
