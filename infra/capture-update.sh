#!/bin/sh
# Puts the capture.ts the deploy uploaded into place on the capture host and restarts capture, only if the
# file changed (#87, ADR-016 decision 3), so a deploy that changes nothing costs capture no poll. A failed
# download stops here and leaves the running version alone. A new file that does not stay up is replaced
# by the previous one, kept as capture.ts.prev, and the command fails with the journal's last lines.
#
# Usage: ci.yml's deploy job sends it through Run Command, which runs it as root, with BUCKET replaced by the
#   archive bucket's name. infra/test-capture-update.sh checks it.
set -eu
cd /opt/stopsignal
aws s3 cp s3://BUCKET/deploy/capture.ts capture.ts.new --region ap-southeast-2 --only-show-errors
if cmp -s capture.ts.new capture.ts; then
  rm capture.ts.new
  echo "capture.ts unchanged; capture not restarted"
  exit 0
fi

rm -f capture.ts.prev
[ ! -e capture.ts ] || cp -p capture.ts capture.ts.prev
mv capture.ts.new capture.ts
systemctl restart stopsignal-capture
# A restart returns once the process starts, so a file that crashes on load still reports success. The
# unit waits 10 s before each automatic restart, so at 15 s a crashing capture is not active.
sleep 15
if systemctl is-active --quiet stopsignal-capture; then
  echo "capture.ts replaced; capture restarted"
  exit 0
fi

journalctl -u stopsignal-capture -n 30 --no-pager
if [ -e capture.ts.prev ]; then
  mv capture.ts.prev capture.ts
  systemctl restart stopsignal-capture
  echo "the new capture.ts did not stay up; the previous one is back and capture restarted" >&2
else
  echo "the new capture.ts did not stay up, and there is no previous one to put back" >&2
fi
exit 1
