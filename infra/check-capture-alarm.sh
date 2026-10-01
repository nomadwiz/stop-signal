#!/usr/bin/env bash
# Checks the capture alarm against #11's acceptance: stopping capture puts the alarm in ALARM within
# five minutes, and restarting capture returns it to OK. Exits non-zero on the first failure.
#
# Usage: infra/check-capture-alarm.sh
#   Run from your machine with the AWS CLI profile `stopsignal`, after infra/capture-alarm.sh, once the
#   email subscription is confirmed and the alarm is OK. It stops capture until the alarm fires, about 3–5
#   minutes and never over 330 s, and those polls are lost for good. It restarts capture on every exit,
#   Ctrl-C included, and a timer armed on the host restarts it after 16 minutes if this machine sleeps or disconnects.
#   It reads the alarm's state and history, not the inbox: confirm by hand that the alarm email arrived.
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

. "$(dirname "$0")/on-host.sh"

# Seconds from $2 until the alarm reaches state $1, polled every 10 s; fails after $3 seconds.
wait_for() {
  while [ $(($(date +%s) - $2)) -le "$3" ]; do
    [ "$(state)" = "$1" ] && { echo $(($(date +%s) - $2)); return 0; }
    sleep 10
  done
  return 1
}

# The rescue timer stays loaded after it fires, so every start and every arming clears it first,
# or a rerun's systemd-run would fail on a unit that already exists.
CLEAR='systemctl stop stopsignal-capture-rescue.timer 2>/dev/null;'
START="$CLEAR systemctl start stopsignal-capture"
restart() {
  on_host "$START" >/dev/null \
    || echo "FAIL: capture is still stopped on $ID; start it now: systemctl start stopsignal-capture" >&2
}
# Set before the stop, so even a stop that half-succeeds is undone. Ctrl-C exits, which runs it.
trap restart EXIT
trap 'exit 1' INT TERM

# The rescue (960 s, 16 minutes) is armed in the same command as the stop, so capture never stops without it.
on_host "$CLEAR systemd-run --collect --on-active=960 --unit=stopsignal-capture-rescue /usr/bin/systemctl start stopsignal-capture \
  && systemctl stop stopsignal-capture" >/dev/null || fail "cannot arm the rescue and stop capture"
stopped=$(date +%s)
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "capture stopped; waiting for ALARM"
alarm_after=$(wait_for ALARM "$stopped" 330) || fail "$ALARM did not reach ALARM within 330 s of the stop"
echo "ALARM ${alarm_after}s after the stop"

on_host "$START" >/dev/null || fail "cannot restart capture"
trap - EXIT
restarted=$(date +%s)
pass "capture restarted after a gap of $((restarted - stopped))s"

ok_after=$(wait_for OK "$restarted" 600) || fail "$ALARM did not return to OK within 10 minutes of the restart"
pass "$ALARM returned to OK ${ok_after}s after the restart"

# The state proves the alarm fired; its Action history item, read after OK so it has long been written,
# proves it published to the topic. The alarm has no OK action, so the newest one is ALARM's.
# ponytail: matches "successfully" loosely, as AWS documents no example of an Action item's summary.
summary=$(aws cloudwatch describe-alarm-history --alarm-name "$ALARM" --history-item-type Action --start-date "$since" \
  --max-items 1 --query 'AlarmHistoryItems[0].HistorySummary' --output text)
echo "$summary" | grep -qi successfully || fail "$ALARM reached ALARM but its action did not succeed: $summary"
pass "$ALARM executed its action: $summary"

[ "$alarm_after" -le 300 ] || fail "ALARM came ${alarm_after}s after the stop, over the five minutes #11 accepts"
pass "ALARM came ${alarm_after}s after the stop, within five minutes; confirm the email arrived"
