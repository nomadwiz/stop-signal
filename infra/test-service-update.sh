#!/usr/bin/env bash
# Checks infra/service-update.sh, the command that installs the hail service's build and timetable on the
# service host (#50): it swaps them in and restarts the service only when either differs from what runs,
# puts the previous ones back when the new build does not stay up, and changes nothing when a download fails.
#
# Usage: infra/test-service-update.sh
#   Runs offline. The script is run with /opt/stopsignal pointed at a temporary folder and with aws,
#   systemctl, journalctl and sleep stubbed, so it checks the shell the host runs, not a copy of it.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
check() { if eval "$2"; then echo "ok:   $1"; else echo "FAIL: $1"; fail=1; fi; }

# $1 is the build S3 holds, $2 the timetable S3 holds ("" leaves that object out, so its download fails),
# $3 the build the host runs ("" means none yet), with the timetable "zip". Each build is one file, main.ts,
# holding that text. DOWN set makes the service fail to stay up. $T/log holds the systemctl calls, $T/out the
# output, $T/rc the status.
update() {
  T=$(mktemp -d); mkdir "$T/bin" "$T/s3" "$T/src"; : > "$T/log"
  if [ -n "$1" ]; then printf %s "$1" > "$T/src/main.ts"; tar -czf "$T/s3/service.tgz" -C "$T/src" main.ts; fi
  [ -z "$2" ] || printf %s "$2" > "$T/s3/gtfs.zip"
  if [ -n "$3" ]; then mkdir "$T/service"; printf %s "$3" > "$T/service/main.ts"; printf zip > "$T/service/gtfs.zip"; fi
  # aws s3 cp s3://<bucket>/deploy/service/<name> <destination> ...: the destination is the fourth argument.
  printf '#!/bin/sh\ncp "%s/s3/$(basename "$3")" "$4"\n' "$T" > "$T/bin/aws"
  printf '#!/bin/sh\necho "$*" >> "%s/log"\n[ "$1" != is-active ] || [ -z "$DOWN" ]\n' "$T" > "$T/bin/systemctl"
  printf '#!/bin/sh\necho "the journal"\n' > "$T/bin/journalctl"
  printf '#!/bin/sh\n' > "$T/bin/sleep"
  chmod +x "$T/bin/"*
  sed "s#/opt/stopsignal#$T#g; s/BUCKET/archive/g" infra/service-update.sh \
    | DOWN=${DOWN:-} PATH="$T/bin:$PATH" sh > "$T/out" 2>&1
  echo $? > "$T/rc"
}
log() { tr '\n' ' ' < "$T/log"; }
runs() { [ "$(cat "$T/service/main.ts")" = "$1" ] && [ "$(cat "$T/service/gtfs.zip")" = "$2" ]; }
tidy() { [ ! -e "$T/service.new" ] && [ ! -e "$T/service.tgz" ]; }
UP='restart stopsignal-service is-active --quiet stopsignal-service '

update same zip same
check "an unchanged build and timetable are left in place and the service is not restarted" \
  '[ "$(cat $T/rc)" = 0 ] && runs same zip && [ ! -s $T/log ] && tidy'

update new zip old
check "a changed build replaces the old one, the service restarts once and is checked to stay up" \
  '[ "$(cat $T/rc)" = 0 ] && runs new zip && [ "$(log)" = "$UP" ] && tidy'

update same zip2 same
check "a changed timetable alone also replaces and restarts" \
  '[ "$(cat $T/rc)" = 0 ] && runs same zip2 && [ "$(log)" = "$UP" ] && tidy'

update new '' old
check "a failed download fails the command and leaves the service running the old build" \
  '[ "$(cat $T/rc)" != 0 ] && runs old zip && [ ! -s $T/log ]'

DOWN=1 update new zip old
check "a new build that does not stay up is replaced by the old one, restarted, shown and failed" \
  '[ "$(cat $T/rc)" != 0 ] && runs old zip && [ "$(log)" = "${UP}restart stopsignal-service " ] && grep -q "the journal" $T/out'

update new zip ''
check "a first deploy, with nothing installed yet, puts the build in place and restarts" \
  '[ "$(cat $T/rc)" = 0 ] && runs new zip && [ "$(log)" = "$UP" ] && tidy'

DOWN=1 update new zip ''
check "a first deploy that does not stay up fails without a previous build to restore" \
  '[ "$(cat $T/rc)" != 0 ] && [ "$(log)" = "$UP" ] && grep -q "the journal" $T/out'

exit $fail
