#!/usr/bin/env bash
# Checks infra/deploy-user.sh's handling of the access key: a key is made only when there is no active one
# or on --rotate-key, it reaches the two secrets and never the output, the old key is deleted only after
# both secrets are set, and a failed store deletes the new key and keeps the old one.
#
# Usage: infra/test-deploy-user.sh
#   Runs offline, with aws and gh stubbed on PATH.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
check() { if eval "$2"; then echo "ok:   $1"; else echo "FAIL: $1"; fail=1; fi; }

# $1 the script's argument. ACTIVE (active keys), OLD (existing key IDs) and FAIL_GH (a secret whose set
# fails) come from the environment. $T/log holds the calls in order, $T/out the script's output.
run() {
  T=$(mktemp -d); mkdir "$T/bin"; : > "$T/log"; export T
  cat > "$T/bin/aws" <<'EOF'
#!/bin/bash
case "$1 $2" in
  "sts get-caller-identity") echo 123456789012;;
  "iam get-user") ;;
  "iam put-user-policy") echo put >> "$T/log";;
  "iam list-access-keys") if [[ "$*" == *length* ]]; then echo "$ACTIVE"; else echo "$OLD"; fi;;
  "iam create-access-key") echo create >> "$T/log"; echo '{"AccessKey":{"AccessKeyId":"AKIANEW","SecretAccessKey":"s3cr3t"}}';;
  "iam delete-access-key") echo "delete ${*: -1}" >> "$T/log";;
esac
EOF
  cat > "$T/bin/gh" <<'EOF'
#!/bin/bash
[ "$3" = "${FAIL_GH:-}" ] && exit 1
echo "set $3=$(cat)" >> "$T/log"
EOF
  chmod +x "$T/bin/"*
  PATH="$T/bin:$PATH" bash infra/deploy-user.sh "$@" > "$T/out" 2>&1; echo $? > "$T/rc"
}
log() { tr '\n' ' ' < "$T/log"; }

ACTIVE=1 OLD=AKIAOLD run
check "an active key and no flag: nothing is made, stored or deleted" '[ "$(log)" = "put " ] && [ "$(cat $T/rc)" = 0 ]'

ACTIVE=1 OLD=AKIAOLD run --rotate-key
check "rotation stores both halves of the new key, then deletes the old one" \
  '[ "$(log)" = "put create set AWS_ACCESS_KEY_ID=AKIANEW set AWS_SECRET_ACCESS_KEY=s3cr3t delete AKIAOLD " ] && [ "$(cat $T/rc)" = 0 ]'
check "the secret key never reaches the output" '! grep -q s3cr3t $T/out'

ACTIVE=0 OLD= run
check "no active key: one is made and stored without a flag" \
  '[ "$(log)" = "put create set AWS_ACCESS_KEY_ID=AKIANEW set AWS_SECRET_ACCESS_KEY=s3cr3t " ] && [ "$(cat $T/rc)" = 0 ]'

ACTIVE=1 OLD=AKIAOLD FAIL_GH=AWS_SECRET_ACCESS_KEY run --rotate-key
check "a failed store deletes the new key, keeps the old one and fails" \
  '[ "$(log)" = "put create set AWS_ACCESS_KEY_ID=AKIANEW delete AKIANEW " ] && [ "$(cat $T/rc)" != 0 ] && ! grep -q s3cr3t $T/out'

exit $fail
