#!/bin/bash
# Installs the capture heartbeat (#11): a timer that publishes StopSignal/Capture Heartbeat each minute,
# 1 while the newest snapshot is under 2 minutes old and 0 otherwise, so a capture process that is
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
# Age in seconds from stat, not find -mmin, whose rounding GNU's manual page leaves unstated.
newest=$(find /var/lib/stopsignal/archive -name '*.pb.gz' | sort | tail -1)
value=0
[ -n "$newest" ] && [ $(($(date +%s) - $(stat -c %Y "$newest"))) -lt 120 ] && value=1
# A real 0, not silence: the alarm reads missing data as breaching only once no real point is left in its range.
exec aws cloudwatch put-metric-data --region ap-southeast-2 --namespace StopSignal/Capture --metric-name Heartbeat --value "$value"
EOF
chmod 755 /opt/stopsignal/heartbeat.sh

cat > /etc/systemd/system/stopsignal-heartbeat.service <<'EOF'
[Unit]
Description=Publish the capture heartbeat: 1 if a snapshot was written in the last 2 minutes, else 0

[Service]
Type=oneshot
User=stopsignal
ExecStart=/opt/stopsignal/heartbeat.sh
EOF

# At second 30, mid-period, so the CLI's start-up delay never pushes a heartbeat into the next minute:
# each one-minute period holds exactly one, which matters when the alarm judges a single period.
cat > /etc/systemd/system/stopsignal-heartbeat.timer <<'EOF'
[Unit]
Description=Run stopsignal-heartbeat every minute

[Timer]
OnCalendar=*-*-* *:*:30
AccuracySec=1s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now stopsignal-heartbeat.timer
