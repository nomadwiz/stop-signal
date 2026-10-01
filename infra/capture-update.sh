#!/bin/sh
# Puts the capture.ts the deploy uploaded into place on the capture host and restarts capture, only if the
# file changed (#87, ADR-016 decision 3), so a deploy that changes nothing costs capture no poll. A failed
# download stops here and leaves the running version alone.
#
# Usage: ci.yml's deploy job sends it through Run Command, which runs it as root, with BUCKET replaced by the
#   archive bucket's name. infra/test-capture-update.sh checks it.
set -eu
cd /opt/stopsignal
aws s3 cp s3://BUCKET/deploy/capture.ts capture.ts.new --region ap-southeast-2 --only-show-errors
if cmp -s capture.ts.new capture.ts; then
  rm capture.ts.new
  echo "capture.ts unchanged; capture not restarted"
else
  mv capture.ts.new capture.ts
  systemctl restart stopsignal-capture
  echo "capture.ts replaced; capture restarted"
fi
