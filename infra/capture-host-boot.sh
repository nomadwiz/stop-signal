#!/bin/bash
# First-boot set-up of the capture host. infra/capture-host.sh passes this as EC2 user data,
# with BUCKET replaced by the archive bucket's name. Its output is in /var/log/cloud-init-output.log.
set -euxo pipefail
export AWS_REGION=ap-southeast-2

dnf install -y nodejs22
NODE=$(command -v node-22 || command -v node)
useradd --system --shell /sbin/nologin --home-dir /var/lib/stopsignal stopsignal
install -d -o stopsignal /var/lib/stopsignal /var/lib/stopsignal/archive
install -d /opt/stopsignal
aws s3 cp s3://BUCKET/deploy/capture.ts /opt/stopsignal/capture.ts
# No package.json sits above the file, so declare ES modules rather than rely on Node's syntax detection.
echo '{"type":"module"}' > /opt/stopsignal/package.json

# The key is read at every start, so rotating it in Parameter Store needs only a restart.
# --experimental-strip-types because AL2023's nodejs22 may predate 22.18, where stripping became the default.
cat > /opt/stopsignal/run-capture.sh <<EOF
#!/bin/sh
# set -e stops here if the key cannot be read, so the journal shows the AWS error, not capture's usage line.
set -e
AT_KEY=\$(aws ssm get-parameter --region $AWS_REGION --name /stopsignal/at-key --with-decryption --query Parameter.Value --output text)
export AT_KEY
exec $NODE --experimental-strip-types /opt/stopsignal/capture.ts /var/lib/stopsignal/archive
EOF

# Uploads whole snapshots only, then frees the disk of what S3 already holds; set -e skips the delete if an upload fails.
# One sync per local date folder, so each lists one day of raw/ rather than the whole archive.
cat > /opt/stopsignal/sync.sh <<'EOF'
#!/bin/sh
set -e
for dir in /var/lib/stopsignal/archive/*/; do
  [ -d "$dir" ] || continue
  aws s3 sync "$dir" "s3://BUCKET/raw/$(basename "$dir")/" --region ap-southeast-2 --exclude '*' --include '*.pb.gz' --only-show-errors
done
find /var/lib/stopsignal/archive \( -name '*.pb.gz' -o -name '*.tmp' \) -mmin +60 -delete
find /var/lib/stopsignal/archive -mindepth 1 -type d -empty -delete
EOF
chmod 755 /opt/stopsignal/*.sh

cat > /etc/systemd/system/stopsignal-capture.service <<'EOF'
[Unit]
Description=StopSignal feed capture
Wants=network-online.target
After=network-online.target

[Service]
User=stopsignal
ExecStart=/opt/stopsignal/run-capture.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/stopsignal-sync.service <<'EOF'
[Unit]
Description=Upload the capture archive to S3 and free the disk

[Service]
Type=oneshot
User=stopsignal
ExecStart=/opt/stopsignal/sync.sh
EOF

cat > /etc/systemd/system/stopsignal-sync.timer <<'EOF'
[Unit]
Description=Run stopsignal-sync every 5 minutes

# Every 5 minutes, so a snapshot reaches S3 within 10 minutes of being written, as #10 accepts.
[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
AccuracySec=1s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now stopsignal-capture.service stopsignal-sync.timer
