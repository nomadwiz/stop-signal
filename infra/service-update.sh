#!/bin/sh
# Installs the hail service's build and timetable from S3 on the service host and restarts the service, only if
# either changed (#50, ADR-016 decision 5), since a restart ends every live hail. A failed download stops here
# and leaves the running service alone. A new build that does not stay up is replaced by the previous one, kept
# as service.prev, and the command fails with the journal's last lines. The roll-back is on the host only, as
# capture-update.sh's is.
#
# Usage: infra/service-host.sh and ci.yml's deploy job send it through Run Command, which runs it as root, with
#   BUCKET replaced by the archive bucket's name. infra/test-service-update.sh checks it.
set -eu
cd /opt/stopsignal
rm -rf service.new
mkdir service.new
aws s3 cp s3://BUCKET/deploy/service/service.tgz service.tgz --region ap-southeast-2 --only-show-errors
aws s3 cp s3://BUCKET/deploy/service/gtfs.zip service.new/gtfs.zip --region ap-southeast-2 --only-show-errors
# Owned by root, whoever packed it; the service only reads it.
tar -xzf service.tgz -C service.new --no-same-owner
rm service.tgz
# Compared by content, so a build packed again with new timestamps restarts nothing.
if diff -r service.new service >/dev/null 2>&1; then
  rm -rf service.new
  echo "build and timetable unchanged; the service not restarted"
  exit 0
fi

rm -rf service.prev
[ ! -e service ] || mv service service.prev
mv service.new service
systemctl restart stopsignal-service
# As in capture-update.sh: the unit waits 10 s before each automatic restart, so at 15 s a crashing service is
# not active. Loading the timetable takes longer, so this catches a build that fails to start, not one that
# fails to load it; infra/check-service-host.sh checks the load.
sleep 15
if systemctl is-active --quiet stopsignal-service; then
  echo "service replaced and restarted"
  exit 0
fi

journalctl -u stopsignal-service -n 30 --no-pager
if [ -e service.prev ]; then
  rm -rf service
  mv service.prev service
  systemctl restart stopsignal-service
  echo "the new build did not stay up; the previous one is back and the service restarted" >&2
else
  echo "the new build did not stay up, and there is no previous one to put back" >&2
fi
exit 1
