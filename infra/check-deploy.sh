#!/usr/bin/env bash
# Checks the deploy route against #87's acceptance. Exits non-zero on the first failure.
#
# Usage: infra/check-deploy.sh
#   Run from the build repository's root with the AWS CLI profile `stopsignal` and gh signed in, once the
#   CI run on master's head has finished. Run it after a merge that changes feed-capture, and again after
#   one that does not: the last check reads which of the two the latest deploy was.
set -euo pipefail
export AWS_PROFILE=stopsignal AWS_REGION=ap-southeast-2
REPO=nomadwiz/stop-signal

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok:   $*"; }

NAME=stopsignal-deploy
aws iam get-user --user-name "$NAME" >/dev/null 2>&1 || fail "no user $NAME; run infra/deploy-user.sh"
keys=$(aws iam list-access-keys --user-name "$NAME" --query "length(AccessKeyMetadata[?Status=='Active'])" --output text)
[ "$keys" = 1 ] || fail "$NAME has $keys active access keys, not 1; run infra/deploy-user.sh --rotate-key"
pass "$NAME exists with one active access key"

# Its grants are exactly the policy file: one inline policy, equal to the file once rendered, nothing attached
# and no group, since a group's policies would reach it too.
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
want=$(sed "s/BUCKET/stopsignal-archive-$ACCOUNT/g; s/ACCOUNT/$ACCOUNT/g" "$(dirname "$0")/deploy-user-policy.json" | jq -S .)
[ "$(aws iam list-user-policies --user-name "$NAME" --query PolicyNames --output text)" = deploy ] \
  && [ -z "$(aws iam list-attached-user-policies --user-name "$NAME" --query AttachedPolicies --output text)" ] \
  && [ -z "$(aws iam list-groups-for-user --user-name "$NAME" --query Groups --output text)" ] \
  && [ "$(aws iam get-user-policy --user-name "$NAME" --policy-name deploy --query PolicyDocument --output json | jq -S .)" = "$want" ] \
  || fail "$NAME's grants are not exactly infra/deploy-user-policy.json: infra/deploy-user.sh rewrites the inline policy; remove any other policy or group by hand"
pass "$NAME holds only infra/deploy-user-policy.json and is in no group"

# Names only, as gh cannot read a value: the key's two halves live in the deploy environment, and no
# repository-level secret is named for AWS, since every workflow on every branch can read those.
env_secrets=$(gh secret list -R "$REPO" -e deploy --json name --jq '[.[].name] | sort | join(" ")')
[ "$env_secrets" = "AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY" ] \
  || fail "the deploy environment's secrets are '$env_secrets', not AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY; run infra/deploy-user.sh --rotate-key"
repo_aws=$(gh secret list -R "$REPO" --json name --jq '[.[].name | select(test("aws"; "i"))] | join(" ")')
[ -z "$repo_aws" ] || fail "$REPO holds repository-level AWS secrets: $repo_aws; delete them, as the key belongs in the deploy environment"
pass "the deploy environment holds AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, and the repository no AWS secret"

# Only master may deploy: a custom branch policy whose one rule is the branch master.
[ "$(gh api "repos/$REPO/environments/deploy" --jq '.deployment_branch_policy == {protected_branches: false, custom_branch_policies: true}')" = true ] \
  && [ "$(gh api "repos/$REPO/environments/deploy/deployment-branch-policies" --jq '[.branch_policies[] | {name, type}] == [{name: "master", type: "branch"}]')" = true ] \
  || fail "the deploy environment does not limit deployments to the branch master alone"
pass "the deploy environment accepts deployments from master alone"

head=$(gh api "repos/$REPO/commits/master" --jq .sha)
read -r run started_run sha < <(gh run list -R "$REPO" -w ci.yml -b master -s success -L 1 \
  --json databaseId,createdAt,headSha --jq '.[0] | "\(.databaseId) \(.createdAt | fromdateiso8601) \(.headSha)"') \
  || fail "no successful CI run on master"
[ "$sha" = "$head" ] || fail "the latest successful CI run on master is for $sha, not master's head $head; wait for CI"
pass "CI run $run deployed master's head $head"

. "$(dirname "$0")/on-host.sh"
want=$(gh api -H 'Accept: application/vnd.github.raw' "repos/$REPO/contents/packages/feed-capture/src/capture.ts?ref=$head" | shasum -a 256 | cut -d' ' -f1)
read -r have installed started < <(on_host 'cd /opt/stopsignal && echo "$(sha256sum < capture.ts | cut -d" " -f1) $(stat -c %Y capture.ts) $(date -d "$(systemctl show -p ActiveEnterTimestamp --value stopsignal-capture)" +%s)"') \
  || fail "cannot read capture.ts and the service's start time on $ID"
[ "$have" = "$want" ] || fail "the host's capture.ts is not master's"
pass "the host's capture.ts is master's"

# The service must have started after the file it runs was put in place. A file put in place before the
# run means the run found it unchanged, and then the service must not have restarted during the run.
[ "$started" -ge "$installed" ] || fail "capture.ts was replaced at $installed but capture last started at $started, so it runs the old code"
if [ "$installed" -ge "$started_run" ]; then
  pass "run $run replaced capture.ts and restarted capture"
else
  [ "$started" -lt "$started_run" ] \
    || fail "run $run left capture.ts unchanged, yet capture started at $started, after the run began; a crash restarts it too, so read journalctl -u stopsignal-capture"
  pass "run $run left capture.ts unchanged and did not restart capture"
fi
