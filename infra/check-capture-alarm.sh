#!/usr/bin/env bash
# Checks the capture alarm against #11's acceptance: stopping capture puts the alarm in ALARM within
# five minutes, and restarting capture returns it to OK. Exits non-zero on the first failure.
#
# Usage: infra/check-capture-alarm.sh
#   Run from your machine with the AWS CLI profile `stopsignal`, after infra/capture-alarm.sh, once the
#   email subscription is confirmed and the alarm is OK. It stops capture until the alarm fires, at most
#   15 minutes, and those polls are lost for good. It restarts capture on every exit, Ctrl-C included.
#   It reads the alarm's state, not the inbox: confirm by hand that the alarm email arrived.
set -euo pipefail
export AWS_PROFILE=stopsignal AWS_REGION=ap-southeast-2
NAME=stopsignal-capture
ALARM=$NAME-heartbeat
TOPIC=arn:aws:sns:$AWS_REGION:$(aws sts get-caller-identity --query Account --output text):$NAME

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok:   $*"; }
state() { aws cloudwatch describe-alarms --alarm-names "$ALARM" --query 'MetricAlarms[0].StateValue' --output text; }

# Everything before the stop only reads, so a missing piece fails without pausing capture.
aws cloudwatch describe-alarms --alarm-names "$ALARM" --query 'MetricAlarms[0].AlarmActions' --output text | grep -q "$TOPIC" \
  || fail "no alarm $ALARM that notifies $TOPIC; run infra/capture-alarm.sh"
pass "$ALARM notifies $TOPIC"
# A subscription awaiting confirmation is listed with the ARN PendingConfirmation and receives nothing.
[ "$(aws sns list-subscriptions-by-topic --topic-arn "$TOPIC" \
  --query "length(Subscriptions[?Protocol=='email' && SubscriptionArn!='PendingConfirmation'])" --output text)" -gt 0 ] \
  || fail "$TOPIC has no confirmed email subscription; open the confirmation email"
pass "$TOPIC has a confirmed email subscription"
[ "$(state)" = OK ] || fail "$ALARM is $(state), not OK; rerun once capture has published heartbeats for a few minutes"
pass "$ALARM is OK"

ID=$(aws ec2 describe-instances --filters Name=tag:Name,Values=$NAME Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].InstanceId' --output text)
[ -n "$ID" ] || fail "no running instance tagged $NAME"

# As in infra/check-capture-host.sh: runs a shell command on the instance through Systems Manager,
# prints its output and errors, and fails if the command fails.
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

# Seconds from $2 until the alarm reaches state $1, polled every 10 s; fails after $3 seconds.
wait_for() {
  while [ $(($(date +%s) - $2)) -le "$3" ]; do
    [ "$(state)" = "$1" ] && { echo $(($(date +%s) - $2)); return 0; }
    sleep 10
  done
  return 1
}

restart() {
  on_host 'systemctl start stopsignal-capture' >/dev/null \
    || echo "FAIL: capture is still stopped on $ID; start it now: systemctl start stopsignal-capture" >&2
}
# Set before the stop, so even a stop that half-succeeds is undone. Ctrl-C exits, which runs it.
trap restart EXIT
trap 'exit 1' INT TERM

on_host 'systemctl stop stopsignal-capture' >/dev/null || fail "cannot stop capture"
stopped=$(date +%s)
echo "capture stopped; waiting for ALARM"
alarm_after=$(wait_for ALARM "$stopped" 900) || fail "$ALARM did not reach ALARM within 15 minutes of the stop"
echo "ALARM ${alarm_after}s after the stop"

on_host 'systemctl start stopsignal-capture' >/dev/null || fail "cannot restart capture"
trap - EXIT
restarted=$(date +%s)
pass "capture restarted after a gap of $((restarted - stopped))s"
ok_after=$(wait_for OK "$restarted" 600) || fail "$ALARM did not return to OK within 10 minutes of the restart"
pass "$ALARM returned to OK ${ok_after}s after the restart"

[ "$alarm_after" -le 300 ] || fail "ALARM came ${alarm_after}s after the stop, over the five minutes #11 accepts"
pass "ALARM came ${alarm_after}s after the stop, within five minutes; confirm the email arrived"
