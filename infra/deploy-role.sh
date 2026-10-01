#!/usr/bin/env bash
# Creates what ci.yml's deploy job signs in with (#87, ADR-016 decision 2): GitHub's OpenID Connect provider,
# and the role stopsignal-deploy, which only master of nomadwiz/stop-signal may assume and which holds the
# grants in infra/deploy-role-policy.json.
#
# Usage: infra/deploy-role.sh
#   Run from the build repository's root with the AWS CLI profile `stopsignal`. Safe to re-run: it creates
#   only what is missing and rewrites both policies. Then merge a change and run infra/check-deploy.sh.
set -euo pipefail
export AWS_PROFILE=stopsignal AWS_REGION=ap-southeast-2
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
NAME=stopsignal-deploy
HERE=$(dirname "$0")
PROVIDER=arn:aws:iam::$ACCOUNT:oidc-provider/token.actions.githubusercontent.com
# The repository was created after 15-07-2026, so GitHub puts the owner's and the repository's IDs in the
# subject. gh api repos/nomadwiz/stop-signal/actions/oidc/customization/sub prints the prefix.
SUB='repo:nomadwiz@60332249/stop-signal@1341573837:ref:refs/heads/master'

# No thumbprint: IAM fetches one itself and verifies GitHub's certificate against its own trusted CAs.
aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER" >/dev/null 2>&1 \
  || aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com >/dev/null

TRUST=$(jq -n --arg p "$PROVIDER" --arg sub "$SUB" '{Version: "2012-10-17", Statement: [{
  Effect: "Allow", Principal: {Federated: $p}, Action: "sts:AssumeRoleWithWebIdentity",
  Condition: {StringEquals: {"token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                             "token.actions.githubusercontent.com:sub": $sub}}}]}')
if aws iam get-role --role-name "$NAME" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$NAME" --policy-document "$TRUST"
else
  aws iam create-role --role-name "$NAME" --assume-role-policy-document "$TRUST" >/dev/null
fi
aws iam put-role-policy --role-name "$NAME" --policy-name deploy \
  --policy-document "$(sed "s/BUCKET/stopsignal-archive-$ACCOUNT/g; s/ACCOUNT/$ACCOUNT/g" "$HERE/deploy-role-policy.json")"
echo "role $NAME: arn:aws:iam::$ACCOUNT:role/$NAME"
