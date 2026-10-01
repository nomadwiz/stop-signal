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

wait_online || fail "Systems Manager cannot reach the instance"
pass "Systems Manager reaches the instance"

if [ "${1:-}" = reboot ]; then
  # reboot-instances returns before the guest restarts, so compare boot times to prove it did.
  booted=$(on_host 'uptime -s')
  aws ec2 reboot-instances --instance-ids "$ID"
  echo "rebooting; waiting for the agent and the first poll"
  sleep 90
  wait_online || fail "Systems Manager cannot reach the instance after the reboot"
  [ "$(on_host 'uptime -s')" != "$booted" ] || fail "the instance did not reboot"
  pass "the instance rebooted"
fi

on_host 'systemctl is-active stopsignal-capture' >/dev/null || fail "capture service is not active"
pass "capture service is active"

# After a reboot, only a file newer than the boot proves capture resumed.
since='-mmin -2' when='in the last 2 minutes'
if [ "${1:-}" = reboot ]; then since='-newermt "$(uptime -s)"' when='since the reboot'; fi
newest=$(on_host "find /var/lib/stopsignal/archive -name '*.pb.gz' $since | sort | tail -1") || true
# Only a snapshot path counts: on_host also prints errors, and the pipe hides find's exit status.
echo "$newest" | grep -q '\.pb\.gz$' || fail "no snapshot written $when"
pass "a snapshot was written $when"

on_host 'test -z "$(find /var/lib/stopsignal/archive -name "*.pb.gz" -mmin +70)"' >/dev/null \
  || fail "snapshots older than 70 minutes remain on the disk"
pass "the disk holds no snapshot older than 70 minutes"

# The acceptance itself: a snapshot written more than 10 minutes ago is already in S3.
# The newest such file is the one most likely to be missing, so it is the one checked.
old=$(on_host 'cd /var/lib/stopsignal/archive && find . -name "*.pb.gz" -mmin +10 -mmin -15 | sort | tail -1')
key=$(echo "$old" | grep -o '[0-9-]*/[0-9]*\.pb\.gz$') || fail "no snapshot 10–15 minutes old on the host yet; rerun once it has run 15 minutes"
aws s3api head-object --bucket "$BUCKET" --key "raw/$key" >/dev/null 2>&1 || fail "raw/$key, written over 10 minutes ago, is not in S3"
pass "raw/$key, written over 10 minutes ago, is in S3"

for target in "s3://$BUCKET/elsewhere/probe" "s3://$BUCKET/deploy/probe"; do
  # Only AccessDenied counts: any other failure means the probe did not run.
  out=$(on_host "aws s3 cp /etc/hostname $target --region $AWS_REGION") && fail "the instance wrote $target"
  echo "$out" | grep -q AccessDenied || fail "the write probe to $target failed for another reason: $out"
  pass "the instance cannot write $target"
done
