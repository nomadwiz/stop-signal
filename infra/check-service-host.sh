#!/usr/bin/env bash
# Checks the hail service's host against #50's acceptance: HTTPS reaches the service, basic_auth guards the
# console and nothing else, the timetable loaded, each run writes a decision log of its own, the instance's role
# reaches only its own prefix and parameters, and a silent stream stays open for 10 minutes. Exits non-zero on the
# first failure. It restarts the service once, which ends every live hail, and takes about 11 minutes.
#
# Usage: CONSOLE_PASSWORD="$(pbpaste)" infra/check-service-host.sh
#   Run from your machine with the AWS CLI profile `stopsignal`, once infra/service-host.sh has started the host.
#   The password reaches curl on its standard input, never its arguments.
set -euo pipefail
export AWS_PROFILE=stopsignal AWS_REGION=ap-southeast-2
: "${CONSOLE_PASSWORD:?set CONSOLE_PASSWORD to the console password}"
BUCKET=stopsignal-archive-$(aws sts get-caller-identity --query Account --output text)

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok:   $*"; }

INSTANCE=stopsignal-service . "$(dirname "$0")/on-host.sh"
# on_host prints the command's output and its errors joined by a tab; this gives them a line each.
lines() { on_host "$1" | tr '\t' '\n'; }
IP=$(aws ec2 describe-addresses --filters Name=tag:Name,Values=stopsignal-service --query 'Addresses[0].PublicIp' --output text)
URL=https://${IP//./-}.sslip.io
pass "instance $ID is running at $URL"

# Prints the status code of one request; curl checks the certificate. With AUTH set, it sends the console's
# credentials through a config read from standard input.
code() {
  { [ -z "${AUTH:-}" ] || printf 'user = "console:%s"\n' "$CONSOLE_PASSWORD"; } \
    | curl -s -o /dev/null -w '%{http_code}' --max-time 5 -K - "$@" || true
}
empty_register() { code -X POST -H 'content-type: application/json' -d '{}' "$URL/register"; }

# The body lacks every key Register needs, so a 400 can only be the service's own answer (ADR-032, annotated 11-10-2026).
[ "$(empty_register)" = 400 ] || fail "POST /register {} over HTTPS did not reach the service's 400"
pass "POST /register {} over HTTPS, with a certificate curl trusts, reaches the service's 400"

# The console's four kinds of request are refused without the password; GET /signals is a stream, so with it
# curl times out holding the 200.
for request in "GET /" "GET /assets/index.js" "GET /signals" "POST /ack"; do
  [ "$(code -X "${request% *}" "$URL${request#* }")" = 401 ] || fail "$request answered without the password"
done
pass "the console page, its assets, /signals and /ack each answer 401 without the password"
[ "$(AUTH=1 code "$URL/")" = 200 ] || fail "the console page did not answer 200 with the password"
[ "$(AUTH=1 code "$URL/signals")" = 200 ] || fail "/signals did not answer 200 with the password"
[ "$(AUTH=1 code -X POST -H 'content-type: application/json' -d '{}' "$URL/ack")" = 400 ] || fail "POST /ack {} with the password did not reach the service's 400"
pass "with the password, the console page and /signals answer 200 and /ack reaches the service"

line=$(lines 'journalctl -u stopsignal-service -b --no-pager -o cat | grep "^timetable " | tail -1') || fail "cannot read the service's journal"
echo "$line" | grep -Eq "^timetable .*: service day [0-9]{8}, [1-9][0-9]* trips, [1-9][0-9]* stops" || fail "the service loaded no timetable: '$line'"
pass "the service loaded the timetable: $line"

# Each run gets a decision log of its own (ADR-017, decided 11-10-2026): a restart starts a newer file, keeps the
# old one, and the new file holds the decision a Register leads to.
logs='ls /var/lib/stopsignal/decisions | sort -n'
before=$(lines "$logs") || fail "cannot list the decision logs"
on_host 'systemctl restart stopsignal-service' >/dev/null || fail "cannot restart the service"
for _ in $(seq 1 30); do [ "$(empty_register)" = 400 ] && break; sleep 2; done
[ "$(empty_register)" = 400 ] || fail "the service did not answer within a minute of its restart"
code -X POST -H 'content-type: application/json' \
  -d '{"handle":"6f1c2a1e-1b2c-4d3e-8f4a-5b6c7d8e9f00","stop":"7177-4660a5ff","route":"70-205","duration":0}' "$URL/register" >/dev/null
after=$(lines "$logs") || fail "cannot list the decision logs"
newest=$(echo "$after" | grep -E '^[0-9]{13}\.jsonl$' | tail -1)
[ "$newest" != "$(echo "$before" | grep -E '^[0-9]{13}\.jsonl$' | tail -1)" ] || fail "the restart started no new decision log"
[ "$(echo "$after" | grep -c .)" -gt "$(echo "$before" | grep -c .)" ] || fail "the restart removed an earlier decision log"
on_host "grep -q '\"seq\":1,.*\"kind\":\"registered\"' /var/lib/stopsignal/decisions/$newest" >/dev/null \
  || fail "the new decision log $newest does not hold the Register's decision as seq 1"
pass "the restart started $newest, keeping the earlier logs, and it holds the Register's decision as seq 1"

# Only AccessDenied counts: any other failure means the probe did not run.
for probe in "aws s3 cp /etc/hostname s3://$BUCKET/deploy/service/probe" "aws s3 cp s3://$BUCKET/deploy/capture.ts -" \
    "aws s3 ls s3://$BUCKET/raw/" "aws ssm get-parameter --name /stopsignal/probe"; do
  out=$(on_host "$probe --region $AWS_REGION 2>&1") && fail "the instance ran $probe"
  echo "$out" | grep -Eq 'AccessDenied|Forbidden' || fail "the probe $probe failed for another reason: $out"
done
pass "the instance cannot write its prefix, read capture's file or raw/, or read another parameter"

# Each stream is held open with nothing sent after its opening, as a passenger's /outcomes is between outcomes
# (ADR-038's [OPEN] on a stream heartbeat). curl gives up at 610 s with status 28 only if the stream was still open.
T=$(mktemp -d)
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$T"' EXIT
curl -sSN --max-time 610 -X POST -H 'content-type: application/json' \
  -d '{"handle":"0b7e9c52-3f4d-4a1b-9c8d-2e5f6a7b8c90"}' "$URL/outcomes" > "$T/outcomes" 2>&1 & outcomes=$!
printf 'user = "console:%s"\n' "$CONSOLE_PASSWORD" | curl -sSN --max-time 610 -K - "$URL/signals" > "$T/signals" 2>&1 & signals=$!
echo "holding /outcomes and /signals open for 610 s"
rc=0; wait $outcomes || rc=$?
[ $rc = 28 ] || fail "/outcomes closed before 610 s, with curl status $rc: $(cat "$T/outcomes")"
grep -q '^: replayed$' "$T/outcomes" || fail "/outcomes never sent its ': replayed' line"
rc=0; wait $signals || rc=$?
[ $rc = 28 ] || fail "/signals closed before 610 s, with curl status $rc: $(cat "$T/signals")"
pass "/outcomes and /signals each stayed open for 610 s with nothing sent"
