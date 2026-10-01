#!/usr/bin/env bash
# Checks the capture host against #10's acceptance. Exits non-zero on the first failure.
#
# Usage: infra/check-capture-host.sh [reboot]
#   Run from your machine with the AWS CLI profile `stopsignal`. With `reboot`, it reboots the
#   instance first and checks that capture resumed without a login.
set -euo pipefail
export AWS_PROFILE=stopsignal AWS_REGION=ap-southeast-2
BUCKET=stopsignal-archive-$(aws sts get-caller-identity --query Account --output text)

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok:   $*"; }

ID=$(aws ec2 describe-instances --filters Name=tag:Name,Values=stopsignal-capture Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].InstanceId' --output text)
[ -n "$ID" ] || fail "no running instance tagged stopsignal-capture"
pass "instance $ID is running"

# Runs a shell command on the instance through Systems Manager and prints its output and errors;
# fails if the command fails.
on_host() {
  local cmd status
  cmd=$(aws ssm send-command --instance-ids "$ID" --document-name AWS-RunShellScript \
    --parameters "$(jq -n --arg c "$1" '{commands: [$c]}')" --query Command.CommandId --output text)
  aws ssm wait command-executed --command-id "$cmd" --instance-id "$ID" 2>/dev/null || true
  status=$(aws ssm get-command-invocation --command-id "$cmd" --instance-id "$ID" --query Status --output text)
  aws ssm get-command-invocation --command-id "$cmd" --instance-id "$ID" \
    --query '[StandardOutputContent, StandardErrorContent]' --output text
  [ "$status" = Success ]
}

wait_online() {
  for _ in $(seq 1 40); do
    [ "$(aws ssm describe-instance-information --filters Key=InstanceIds,Values="$ID" \
      --query 'InstanceInformationList[0].PingStatus' --output text)" = Online ] && return 0
    sleep 15
  done
  return 1
}

if [ "${1:-}" = reboot ]; then
  aws ec2 reboot-instances --instance-ids "$ID"
  echo "rebooted; waiting for the agent and the first poll"
  sleep 90
fi

wait_online || fail "Systems Manager cannot reach the instance"
pass "Systems Manager reaches the instance"

node=$(on_host 'node-22 --version 2>/dev/null || node --version') || fail "node is not installed"
echo "      node $node"

on_host 'systemctl is-active stopsignal-capture' >/dev/null || fail "capture service is not active"
pass "capture service is active"

# After a reboot, only a file newer than the boot proves capture resumed.
since='-mmin -2' when='in the last 2 minutes'
if [ "${1:-}" = reboot ]; then since='-newermt "$(uptime -s)"' when='since the reboot'; fi
newest=$(on_host "find /var/lib/stopsignal/archive -name '*.pb.gz' $since | sort | tail -1") || true
[ -n "$(echo "$newest" | tr -d '[:space:]')" ] || fail "no snapshot written $when"
pass "a snapshot was written $when"

on_host 'test -z "$(find /var/lib/stopsignal/archive -name "*.pb.gz" -mmin +70)"' >/dev/null \
  || fail "snapshots older than 70 minutes remain on the disk"
pass "the disk holds no snapshot older than 70 minutes"

# Keys are raw/<UTC date>/<epoch-ms>.pb.gz, so they sort by time; list from yesterday only.
yesterday=$(python3 -c 'import datetime as d; print((d.datetime.now(d.timezone.utc) - d.timedelta(days=1)).strftime("%Y-%m-%d"))')
latest=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix raw/ --start-after "raw/$yesterday" --query 'Contents[-1].LastModified' --output text)
[ "$latest" != None ] || fail "nothing in s3://$BUCKET/raw/ yet"
age=$(python3 -c 'import sys, datetime as d; print(int((d.datetime.now(d.timezone.utc) - d.datetime.fromisoformat(sys.argv[1])).total_seconds()))' "$latest")
[ "$age" -le 720 ] || fail "newest object in raw/ is ${age}s old, over 12 minutes"
pass "newest object in raw/ is ${age}s old"

for target in "s3://$BUCKET/elsewhere/probe" "s3://$BUCKET/deploy/probe"; do
  # Only AccessDenied counts: any other failure means the probe did not run.
  out=$(on_host "aws s3 cp /etc/hostname $target --region $AWS_REGION") && fail "the instance wrote $target"
  echo "$out" | grep -q AccessDenied || fail "the write probe to $target failed for another reason: $out"
  pass "the instance cannot write $target"
done
