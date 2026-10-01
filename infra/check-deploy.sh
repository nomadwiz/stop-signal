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

# GitHub issues the subject in the form this repository is set to, which for one created after
# 15-07-2026 carries the owner's and the repository's IDs; the trust policy must name exactly that.
sub="$(gh api "repos/$REPO/actions/oidc/customization/sub" --jq .sub_claim_prefix):ref:refs/heads/master"
trust=$(aws iam get-role --role-name stopsignal-deploy --query Role.AssumeRolePolicyDocument --output json) \
  || fail "no role stopsignal-deploy; run infra/deploy-role.sh"
# Exactly one statement and exactly these two conditions, so no StringLike wildcard can widen either.
jq -e --arg sub "$sub" '.Statement | length == 1 and (.[0]
  | .Effect == "Allow" and .Action == "sts:AssumeRoleWithWebIdentity"
    and (.Principal.Federated | endswith(":oidc-provider/token.actions.githubusercontent.com"))
    and .Condition == {StringEquals: {"token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                                      "token.actions.githubusercontent.com:sub": $sub}})' <<<"$trust" >/dev/null \
  || fail "stopsignal-deploy's trust policy does not require exactly audience sts.amazonaws.com and subject $sub: $trust"
pass "stopsignal-deploy trusts only audience sts.amazonaws.com and subject $sub"

# Names only: gh cannot read a secret's value, so a key stored under an innocent name would pass.
secrets=$(gh secret list -R "$REPO" --json name --jq '.[].name')
if grep -qi aws <<<"$secrets"; then fail "an AWS secret is stored in $REPO: $(grep -i aws <<<"$secrets" | tr '\n' ' ')"; fi
pass "no secret in $REPO is named for AWS: $(tr '\n' ' ' <<<"$secrets")"

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
