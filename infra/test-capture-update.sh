#!/usr/bin/env bash
# Checks infra/capture-update.sh, the command the deploy runs on the capture host: it replaces capture.ts and
# restarts capture only when the copy in S3 differs, and changes nothing when the download fails (#87).
#
# Usage: infra/test-capture-update.sh
#   Runs offline. The script is run with /opt/stopsignal pointed at a temporary folder and with aws and
#   systemctl stubbed, so it checks the shell the host runs, not a copy of it.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
check() { if eval "$2"; then echo "ok:   $1"; else echo "FAIL: $1"; fail=1; fi; }

# $1 is what S3 holds ("" makes the download fail), $2 what the host runs now; $T/rc is the exit status.
update() {
  T=$(mktemp -d); mkdir "$T/bin"; printf %s "$2" > "$T/capture.ts"; : > "$T/log"
  # aws s3 cp <source> <destination> ...: the destination is the fourth argument.
  printf '#!/bin/sh\n[ -n "$S3" ] || exit 1\nprintf %%s "$S3" > "$4"\n' > "$T/bin/aws"
  printf '#!/bin/sh\necho "$*" >> "%s/log"\n' "$T" > "$T/bin/systemctl"
  chmod +x "$T/bin/"*
  sed "s#/opt/stopsignal#$T#g; s/BUCKET/archive/g" infra/capture-update.sh | S3=$1 PATH="$T/bin:$PATH" sh >/dev/null 2>&1
  echo $? > "$T/rc"
}

update 'same' 'same'
check "an unchanged file is left in place and capture is not restarted" \
  '[ "$(cat $T/rc)" = 0 ] && [ "$(cat $T/capture.ts)" = same ] && [ ! -s $T/log ] && [ ! -e $T/capture.ts.new ]'

update 'new' 'old'
check "a changed file replaces the old one and capture restarts once" \
  '[ "$(cat $T/rc)" = 0 ] && [ "$(cat $T/capture.ts)" = new ] && [ "$(cat $T/log)" = "restart stopsignal-capture" ] && [ ! -e $T/capture.ts.new ]'

update '' 'old'
check "a failed download fails the command and leaves capture running the old file" \
  '[ "$(cat $T/rc)" != 0 ] && [ "$(cat $T/capture.ts)" = old ] && [ ! -s $T/log ]'

exit $fail
