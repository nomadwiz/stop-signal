#!/usr/bin/env bash
# Stands up the capture host (ADR-014, ADR-016): the archive bucket, the instance's scoped role,
# a security group with no inbound rule, and a t4g.micro that runs feed-capture under systemd.
#
# Usage: infra/capture-host.sh
#   Run from the build repository's root with the AWS CLI profile `stopsignal`, after the AT key
#   is stored at /stopsignal/at-key. Store it once from the clipboard, so it never reaches a file or the history:
#
#     aws ssm put-parameter --name /stopsignal/at-key --type SecureString --overwrite --profile stopsignal \
#       --value "$(pbpaste | tr -d '[:space:]')"
#
#   Safe to re-run: it creates only what is missing, refreshes the role policy and the copy of capture.ts
#   in S3 (the host reads it on first boot only; #87 deploys later changes), and launches an instance
#   only if none exists, stopped or running.
#   Then run infra/check-capture-host.sh.
set -euo pipefail
export AWS_PROFILE=stopsignal AWS_REGION=ap-southeast-2
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET=stopsignal-archive-$ACCOUNT
NAME=stopsignal-capture
HERE=$(dirname "$0")

# New buckets block public access by default.
aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null \
  || aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration LocationConstraint="$AWS_REGION" >/dev/null

if ! aws iam get-role --role-name "$NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$NAME" >/dev/null --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
fi
# The role is checked apart from the profile, so a run that stopped between the two steps is repaired.
attached=$(aws iam get-instance-profile --instance-profile-name "$NAME" --query 'InstanceProfile.Roles[0].RoleName' --output text 2>/dev/null) \
  || aws iam create-instance-profile --instance-profile-name "$NAME" >/dev/null
if [ "$attached" != "$NAME" ]; then
  aws iam add-role-to-instance-profile --instance-profile-name "$NAME" --role-name "$NAME"
  sleep 15 # IAM is eventually consistent; a profile used at once can be rejected by run-instances
fi
aws iam put-role-policy --role-name "$NAME" --policy-name capture \
  --policy-document "$(sed "s/BUCKET/$BUCKET/g; s/ACCOUNT/$ACCOUNT/g" "$HERE/capture-role-policy.json")"

aws s3 cp "$HERE/../packages/feed-capture/src/capture.ts" "s3://$BUCKET/deploy/capture.ts" --only-show-errors

SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values="$NAME" --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG" = None ]; then
  # A new group allows all outbound traffic and no inbound; Systems Manager needs only outbound.
  SG=$(aws ec2 create-security-group --group-name "$NAME" --description "Capture host: outbound only" --query GroupId --output text)
fi

RUNNING=$(aws ec2 describe-instances --filters Name=tag:Name,Values="$NAME" Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[].Instances[].InstanceId' --output text)
if [ -z "$RUNNING" ]; then
  AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value --output text)
  RUNNING=$(aws ec2 run-instances --image-id "$AMI" --instance-type t4g.micro \
    --iam-instance-profile Name="$NAME" --security-group-ids "$SG" \
    --metadata-options HttpTokens=required \
    --credit-specification CpuCredits=standard \
    --user-data "$(sed "s/BUCKET/$BUCKET/g" "$HERE/capture-host-boot.sh")" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
    --query 'Instances[0].InstanceId' --output text)
  echo "launched $RUNNING; first boot takes about five minutes"
fi
echo "capture host: $RUNNING, archive: s3://$BUCKET/raw/"
