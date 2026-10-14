#!/bin/bash
# First-boot set-up of the hail service's host (#50). infra/service-host.sh passes this as EC2 user data, with
# SSLIP_NAME replaced by the service's sslip.io name. Its output is in /var/log/cloud-init-output.log. It installs
# Node, Caddy and the units; the build and the timetable arrive afterwards, by infra/service-update.sh.
set -euxo pipefail
export AWS_REGION=ap-southeast-2
# Pinned, and checked against the sha256 of the release file, whose sha512 matched Caddy's published checksums.
CADDY=2.11.7
CADDY_SHA256=d8fc6d179a5d283028a472a5618564f6ad8a86fed513e64f032b3b0b7cc45e42

dnf install -y nodejs22
NODE=$(command -v node-22 || command -v node)
curl -fsSL -o /tmp/caddy.tgz "https://github.com/caddyserver/caddy/releases/download/v$CADDY/caddy_${CADDY}_linux_arm64.tar.gz"
echo "$CADDY_SHA256  /tmp/caddy.tgz" | sha256sum -c
tar -xzf /tmp/caddy.tgz -C /usr/local/bin caddy
rm /tmp/caddy.tgz

useradd --system --shell /sbin/nologin --home-dir /var/lib/stopsignal stopsignal
useradd --system --shell /sbin/nologin --home-dir /var/lib/caddy caddy
install -d -o stopsignal /var/lib/stopsignal /var/lib/stopsignal/decisions
install -d -o caddy /var/lib/caddy
install -d /opt/stopsignal /etc/caddy

# Each run writes its decisions to a file of its own, named by the epoch-ms it starts at, so a restart, which
# starts seq again at 1, never repeats a seq within a file (ADR-017, decided 11-10-2026). Standard error, the
# banner and the timetable line, goes to the journal. The Auckland Transport key is read at every start, as
# capture's is, so starting the instance opens a field-test window in which the service polls the feed (ADR-044
# decision 2).
cat > /opt/stopsignal/run-service.sh <<EOF
#!/bin/sh
# set -e stops here if the key cannot be read, so the journal shows the AWS error.
set -e
AT_KEY=\$(aws ssm get-parameter --region $AWS_REGION --name /stopsignal/at-key --with-decryption --query Parameter.Value --output text)
export AT_KEY
export GTFS_ZIP=/opt/stopsignal/service/gtfs.zip PORT=8080
exec $NODE /opt/stopsignal/service/packages/hail-service/src/main.ts > /var/lib/stopsignal/decisions/\$(date +%s%3N).jsonl
EOF

# The hash is read at every start, so changing the password in Parameter Store needs only a restart of caddy.
cat > /opt/stopsignal/run-caddy.sh <<EOF
#!/bin/sh
# set -e stops here if the hash cannot be read, so the journal shows the AWS error.
set -e
CONSOLE_HASH=\$(aws ssm get-parameter --region $AWS_REGION --name /stopsignal/console-hash --with-decryption --query Parameter.Value --output text)
export CONSOLE_HASH
exec /usr/local/bin/caddy run --config /etc/caddy/Caddyfile
EOF
chmod 755 /opt/stopsignal/*.sh

# The console, its page, assets, signal stream and acknowledgement, sits behind basic_auth (ADR-032, decided
# 11-10-2026), and Caddy serves its build on the service's own origin (ADR-015 decision 2). Every other path goes
# to the service, which answers 404 to one it does not route, so the passenger routes stay open. Caddy logs no
# request, which keeps the handle out of any access log (ADR-032 decision 5). With port 80 closed, the
# certificate comes by the TLS-ALPN challenge on 443.
cat > /etc/caddy/Caddyfile <<'EOF'
# No admin endpoint: a change of config goes through a restart, so no local process can change it unseen.
{
	admin off
}

SSLIP_NAME {
	@console path / /index.html /assets/* /signals /ack
	basic_auth @console {
		console {$CONSOLE_HASH}
	}
	@page path / /index.html /assets/*
	handle @page {
		root * /opt/stopsignal/service/console
		file_server
	}
	handle {
		reverse_proxy 127.0.0.1:8080
	}
}
EOF

cat > /etc/systemd/system/stopsignal-service.service <<'EOF'
[Unit]
Description=StopSignal hail service
Wants=network-online.target
After=network-online.target

[Service]
User=stopsignal
ExecStart=/opt/stopsignal/run-service.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy, terminating TLS in front of the hail service
Wants=network-online.target
After=network-online.target

[Service]
User=caddy
Environment=XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy
AmbientCapabilities=CAP_NET_BIND_SERVICE
ExecStart=/opt/stopsignal/run-caddy.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# The service loads one service day when it starts, so a restart at 04:00 loads the next (ADR-043, annotated
# 11-10-2026). Like any restart, it ends every live hail.
cat > /etc/systemd/system/stopsignal-service-restart.service <<'EOF'
[Unit]
Description=Restart the hail service to load the next service day

[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl restart stopsignal-service
EOF

cat > /etc/systemd/system/stopsignal-service-restart.timer <<'EOF'
[Unit]
Description=Run stopsignal-service-restart at 04:00 in Auckland

[Timer]
OnCalendar=*-*-* 04:00:00 Pacific/Auckland

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
# The service starts once infra/service-update.sh has put its build in place.
systemctl enable stopsignal-service.service
systemctl enable --now caddy.service stopsignal-service-restart.timer
