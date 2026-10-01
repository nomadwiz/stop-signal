#!/usr/bin/env bash
# Checks infra/deploy-user.sh's handling of the access key: a key is made only when there is no active one
# or on --rotate-key, it reaches the two secrets of the deploy environment and never the output, not even under bash -x, inactive keys
# make room before it and the old key is deleted only after both secrets are set, and a failed store deletes
# the new key and points AWS_ACCESS_KEY_ID back at the old one.
#
# Usage: infra/test-deploy-user.sh
#   Runs offline, with aws and gh stubbed on PATH.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
check() { if eval "$2"; then echo "ok:   $1"; else echo "FAIL: $1"; fail=1; fi; }

# $1 the script's argument. OLD (active key IDs), INACTIVE (inactive key IDs), FAIL_GH (a secret whose set
# fails) and XTRACE (run under bash -x) come from the environment. $T/log holds the calls in order, $T/out
# the script's output.
run() {
  T=$(mktemp -d); mkdir "$T/bin"; : > "$T/log"; export T
  cat > "$T/bin/aws" <<'EOF'
#!/bin/bash
case "$1 $2" in
  "sts get-caller-identity") echo 123456789012;;
  "iam get-user") ;;
  "iam put-user-policy") echo put >> "$T/log";;
  "iam list-access-keys") if [[ "$*" == *Inactive* ]]; then echo "${INACTIVE:-}"; else echo "$OLD"; fi;;
  "iam create-access-key") echo create >> "$T/log"; echo '{"AccessKey":{"AccessKeyId":"AKIANEW","SecretAccessKey":"s3cr3t"}}';;
  "iam delete-access-key") echo "delete ${*: -1}" >> "$T/log";;
esac
EOF
  cat > "$T/bin/gh" <<'EOF'
#!/bin/bash
[ "$3" = "${FAIL_GH:-}" ] && exit 1
# Only the deploy environment's secrets count: a repository-level set is logged as such and fails.
[[ " $* " == *" -e deploy "* ]] || { echo "set $3 outside the deploy environment" >> "$T/log"; exit 1; }
echo "set $3=$(cat)" >> "$T/log"
EOF
  chmod +x "$T/bin/"*
  PATH="$T/bin:$PATH" bash ${XTRACE:+-x} infra/deploy-user.sh "$@" > "$T/out" 2>&1; echo $? > "$T/rc"
}
log() { tr '\n' ' ' < "$T/log"; }

OLD=AKIAOLD run
check "an active key and no flag: nothing is made, stored or deleted" '[ "$(log)" = "put " ] && [ "$(cat $T/rc)" = 0 ]'

OLD=AKIAOLD run --rotate-key
check "rotation stores both halves of the new key, then deletes the old one" \
  '[ "$(log)" = "put create set AWS_ACCESS_KEY_ID=AKIANEW set AWS_SECRET_ACCESS_KEY=s3cr3t delete AKIAOLD " ] && [ "$(cat $T/rc)" = 0 ]'
check "the secret key never reaches the output" '! grep -q s3cr3t $T/out'

OLD= run
check "no active key: one is made and stored without a flag" \
  '[ "$(log)" = "put create set AWS_ACCESS_KEY_ID=AKIANEW set AWS_SECRET_ACCESS_KEY=s3cr3t " ] && [ "$(cat $T/rc)" = 0 ]'

OLD=AKIAOLD FAIL_GH=AWS_SECRET_ACCESS_KEY run --rotate-key
check "a failed store deletes the new key, points AWS_ACCESS_KEY_ID back at the old one and fails" \
  '[ "$(log)" = "put create set AWS_ACCESS_KEY_ID=AKIANEW delete AKIANEW set AWS_ACCESS_KEY_ID=AKIAOLD " ] && [ "$(cat $T/rc)" != 0 ] && ! grep -q s3cr3t $T/out'

OLD=AKIAOLD INACTIVE=AKIAOFF run --rotate-key
check "rotation deletes an inactive key before making the new one, so IAM's two-key limit leaves room" \
  '[ "$(log)" = "put delete AKIAOFF create set AWS_ACCESS_KEY_ID=AKIANEW set AWS_SECRET_ACCESS_KEY=s3cr3t delete AKIAOLD " ] && [ "$(cat $T/rc)" = 0 ]'

OLD="AKIAONE AKIATWO" run --rotate-key
check "two active keys stop the rotation before anything is made or deleted" '[ "$(log)" = "put " ] && [ "$(cat $T/rc)" != 0 ]'

XTRACE=1 OLD=AKIAOLD run --rotate-key
check "under bash -x the secret key still never reaches the output" '[ "$(cat $T/rc)" = 0 ] && ! grep -q s3cr3t $T/out'

exit $fail
