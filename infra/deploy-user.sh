#!/usr/bin/env bash
# Creates what ci.yml's deploy job signs in with (#87): the IAM user stopsignal-deploy, holding only the
# grants in infra/deploy-user-policy.json, and its access key, stored as the repository secrets
# AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY. A key and not GitHub's OpenID Connect provider, because the
# account's AWS-managed service control policy denies iam:*Provider* and cannot be changed.
#
# Usage: infra/deploy-user.sh [--rotate-key]
#   Run from the build repository's root with the AWS CLI profile `stopsignal` and gh signed in as someone
#   who may set the repository's secrets. Safe to re-run: it creates the user only if missing, rewrites the
#   policy, and makes a key only when the user has no active one, or when given --rotate-key.
#   The key is never displayed: it goes from AWS straight into gh secret set on standard input. To rotate,
#   run with --rotate-key: the new key is stored first and the old one deleted after, so there is never
#   more than one active key. Then run infra/check-deploy.sh after a deploy.
set -euo pipefail
export AWS_PROFILE=stopsignal AWS_REGION=ap-southeast-2
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
NAME=stopsignal-deploy
REPO=nomadwiz/stop-signal

aws iam get-user --user-name "$NAME" >/dev/null 2>&1 || aws iam create-user --user-name "$NAME" >/dev/null
aws iam put-user-policy --user-name "$NAME" --policy-name deploy \
  --policy-document "$(sed "s/BUCKET/stopsignal-archive-$ACCOUNT/g; s/ACCOUNT/$ACCOUNT/g" "$(dirname "$0")/deploy-user-policy.json")"

old=$(aws iam list-access-keys --user-name "$NAME" --query 'AccessKeyMetadata[].AccessKeyId' --output text)
active=$(aws iam list-access-keys --user-name "$NAME" --query "length(AccessKeyMetadata[?Status=='Active'])" --output text)
if [ "${1:-}" != --rotate-key ] && [ "$active" -gt 0 ]; then
  echo "user $NAME has an active key; pass --rotate-key to replace it"
  exit 0
fi

# Held only in this variable and piped by printf, a shell builtin, so it reaches no file, no argument list
# and no output. If storing it fails, the new key is deleted and the old one keeps working.
key=$(aws iam create-access-key --user-name "$NAME" --output json)
id=$(printf %s "$key" | jq -r .AccessKey.AccessKeyId)
if ! { printf %s "$key" | jq -j .AccessKey.AccessKeyId | gh secret set AWS_ACCESS_KEY_ID -R "$REPO" \
    && printf %s "$key" | jq -j .AccessKey.SecretAccessKey | gh secret set AWS_SECRET_ACCESS_KEY -R "$REPO"; }; then
  aws iam delete-access-key --user-name "$NAME" --access-key-id "$id"
  echo "FAIL: could not store the key in $REPO's secrets; the new key is deleted, so rerun with --rotate-key" >&2
  exit 1
fi
unset key
for k in $old; do aws iam delete-access-key --user-name "$NAME" --access-key-id "$k"; done
echo "stored a new key for $NAME in $REPO's AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY; deleted $(wc -w <<<"$old" | tr -d ' ') old"
