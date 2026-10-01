#!/bin/bash
# Installs the capture heartbeat (#11): a timer that publishes StopSignal/Capture Heartbeat = 1 each
# minute, but only while the newest snapshot is under 2 minutes old, so a capture process that is
# alive but not writing trips the alarm too. feed-capture itself holds no AWS code.
#
# Usage: run as root on the capture host. infra/capture-host.sh uploads it to deploy/ and the first
#   boot runs it; it is safe to run again. On a host already running, run it through Run Command:
#
#     aws ssm send-command --profile stopsignal --region ap-southeast-2 --instance-ids <instance id> \
#       --document-name AWS-RunShellScript --parameters '{"commands":["aws s3 cp s3://<archive bucket>/deploy/capture-heartbeat.sh /opt/stopsignal/ --region ap-southeast-2 && bash /opt/stopsignal/capture-heartbeat.sh"]}'
set -euxo pipefail

cat > /opt/stopsignal/heartbeat.sh <<'EOF'
#!/bin/sh
# Snapshot paths sort by time: a UTC date folder, then a fixed-width epoch-ms name.
newest=$(find /var/lib/stopsignal/archive -name '*.pb.gz' | sort | tail -1)
[ -n "$newest" ] && [ $(($(date +%s) - $(stat -c %Y "$newest"))) -lt 120 ] || exit 0
exec aws cloudwatch put-metric-data --region ap-southeast-2 --namespace StopSignal/Capture --metric-name Heartbeat --value 1
EOF
chmod 755 /opt/stopsignal/heartbeat.sh

cat > /etc/systemd/system/stopsignal-heartbeat.service <<'EOF'
[Unit]
Description=Publish the capture heartbeat if a snapshot was written in the last 2 minutes

[Service]
Type=oneshot
User=stopsignal
ExecStart=/opt/stopsignal/heartbeat.sh
EOF

# On the minute, so each one-minute period of the alarm holds one heartbeat.
cat > /etc/systemd/system/stopsignal-heartbeat.timer <<'EOF'
[Unit]
Description=Run stopsignal-heartbeat every minute

[Timer]
OnCalendar=minutely
AccuracySec=1s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now stopsignal-heartbeat.timer
