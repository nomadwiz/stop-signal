#!/usr/bin/env bash
# Checks infra/capture-update.sh, the command the deploy runs on the capture host: it replaces capture.ts and
# restarts capture only when the copy in S3 differs, puts the previous file back when the new one does not
# stay up, and changes nothing when the download fails (#87).
#
# Usage: infra/test-capture-update.sh
#   Runs offline. The script is run with /opt/stopsignal pointed at a temporary folder and with aws,
#   systemctl, journalctl and sleep stubbed, so it checks the shell the host runs, not a copy of it.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
check() { if eval "$2"; then echo "ok:   $1"; else echo "FAIL: $1"; fail=1; fi; }

# $1 is what S3 holds ("" makes the download fail), $2 what the host runs now ("" means no file yet).
# DOWN set makes capture fail to stay up. $T/log holds the systemctl calls, $T/out the output, $T/rc the status.
update() {
  T=$(mktemp -d); mkdir "$T/bin"; [ -z "$2" ] || printf %s "$2" > "$T/capture.ts"; : > "$T/log"
  # aws s3 cp <source> <destination> ...: the destination is the fourth argument.
  printf '#!/bin/sh\n[ -n "$S3" ] || exit 1\nprintf %%s "$S3" > "$4"\n' > "$T/bin/aws"
  printf '#!/bin/sh\necho "$*" >> "%s/log"\n[ "$1" != is-active ] || [ -z "$DOWN" ]\n' "$T" > "$T/bin/systemctl"
  printf '#!/bin/sh\necho "the journal"\n' > "$T/bin/journalctl"
  printf '#!/bin/sh\n' > "$T/bin/sleep"
  chmod +x "$T/bin/"*
  sed "s#/opt/stopsignal#$T#g; s/BUCKET/archive/g" infra/capture-update.sh \
    | S3=$1 DOWN=${DOWN:-} PATH="$T/bin:$PATH" sh > "$T/out" 2>&1
  echo $? > "$T/rc"
}
log() { tr '\n' ' ' < "$T/log"; }
UP='restart stopsignal-capture is-active --quiet stopsignal-capture '

update 'same' 'same'
check "an unchanged file is left in place and capture is not restarted" \
  '[ "$(cat $T/rc)" = 0 ] && [ "$(cat $T/capture.ts)" = same ] && [ ! -s $T/log ] && [ ! -e $T/capture.ts.new ]'

update 'new' 'old'
check "a changed file replaces the old one, capture restarts once and is checked to stay up" \
  '[ "$(cat $T/rc)" = 0 ] && [ "$(cat $T/capture.ts)" = new ] && [ "$(log)" = "$UP" ] && [ ! -e $T/capture.ts.new ]'

update '' 'old'
check "a failed download fails the command and leaves capture running the old file" \
  '[ "$(cat $T/rc)" != 0 ] && [ "$(cat $T/capture.ts)" = old ] && [ ! -s $T/log ]'

DOWN=1 update 'new' 'old'
check "a new file that does not stay up is replaced by the old one, restarted, shown and failed" \
  '[ "$(cat $T/rc)" != 0 ] && [ "$(cat $T/capture.ts)" = old ] && [ "$(log)" = "${UP}restart stopsignal-capture " ] && grep -q "the journal" $T/out'

update 'new' ''
check "a first deploy, with no file yet, puts the file in place and restarts" \
  '[ "$(cat $T/rc)" = 0 ] && [ "$(cat $T/capture.ts)" = new ] && [ "$(log)" = "$UP" ]'

DOWN=1 update 'new' ''
check "a first deploy that does not stay up fails without a previous file to restore" \
  '[ "$(cat $T/rc)" != 0 ] && [ "$(log)" = "$UP" ] && grep -q "the journal" $T/out'

exit $fail
