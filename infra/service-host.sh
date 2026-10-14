#!/usr/bin/env bash
# Stands up the hail service's host and starts it (#50; ADR-014, ADR-016 decision 5): the instance's scoped role,
# a security group open on 443 alone, an Elastic IP whose sslip.io name Caddy gets a certificate for (ADR-014,
# annotated 11-10-2026), and a t4g.micro that runs the service under systemd behind Caddy. Then it uploads the
# build, keeps the timetable, and installs both on the host.
#
# Usage: infra/service-host.sh
#   Run from master's head in the build repository's root, after npm ci, with the AWS CLI profile `stopsignal`,
#   once the console's password hash is stored at /stopsignal/console-hash. Store it once from the clipboard, so
#   the password never reaches a file or the history:
#
#     aws ssm put-parameter --name /stopsignal/console-hash --type SecureString --overwrite --profile stopsignal \
#       --value "$(pbpaste | htpasswd -niB -C 12 console | cut -d: -f2-)"
#
#   Safe to re-run: it creates only what is missing and launches an instance only if none exists. The instance
#   carries the hash of the boot script it ran, which runs only at its first boot, so after a change to
#   infra/service-host-boot.sh it stops and asks for the instance to be terminated and launched again. A stopped
#   instance is started, which opens a field-test window: the service runs only for those (ADR-044). Close one
#   with the stop command it prints. Then run infra/check-service-host.sh.
set -euo pipefail
export AWS_PROFILE=stopsignal AWS_REGION=ap-southeast-2
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET=stopsignal-archive-$ACCOUNT
NAME=stopsignal-service
HERE=$(dirname "$0")
BOOT=$(shasum -a 256 < "$HERE/service-host-boot.sh" | cut -c1-12)

aws ssm get-parameter --name /stopsignal/console-hash >/dev/null \
  || { echo "FAIL: store the console's password hash at /stopsignal/console-hash first; see this script's usage" >&2; exit 1; }

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
aws iam put-role-policy --role-name "$NAME" --policy-name service \
  --policy-document "$(sed "s/BUCKET/$BUCKET/g; s/ACCOUNT/$ACCOUNT/g" "$HERE/service-role-policy.json")"

SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values="$NAME" --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG" = None ]; then
  # A new group allows all outbound traffic and no inbound. Caddy needs 443 alone: it serves HTTPS there and
  # answers the certificate's TLS-ALPN challenge there, so port 80 stays closed.
  SG=$(aws ec2 create-security-group --group-name "$NAME" --description "Hail service host: HTTPS only" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null
fi

ALLOC=$(aws ec2 describe-addresses --filters Name=tag:Name,Values="$NAME" --query 'Addresses[0].AllocationId' --output text)
if [ "$ALLOC" = None ]; then
  ALLOC=$(aws ec2 allocate-address --domain vpc --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAME}]" \
    --query AllocationId --output text)
fi
IP=$(aws ec2 describe-addresses --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp' --output text)
SITE=${IP//./-}.sslip.io

archive=$(mktemp -d)/service.tgz
"$HERE/service-pack.sh" "$archive"
"$HERE/service-upload.sh" "$BUCKET" "$archive"

ID=$(aws ec2 describe-instances --filters Name=tag:Name,Values="$NAME" Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[].Instances[].InstanceId' --output text)
if [ -z "$ID" ]; then
  AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value --output text)
  ID=$(aws ec2 run-instances --image-id "$AMI" --instance-type t4g.micro \
    --iam-instance-profile Name="$NAME" --security-group-ids "$SG" \
    --metadata-options HttpTokens=required \
    --credit-specification CpuCredits=standard \
    --user-data "$(sed "s/SSLIP_NAME/$SITE/g" "$HERE/service-host-boot.sh")" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=Boot,Value=$BOOT}]" \
    --query 'Instances[0].InstanceId' --output text)
  echo "launched $ID; first boot takes a few minutes"
else
  [ "$(aws ec2 describe-instances --instance-ids "$ID" --query "Reservations[0].Instances[0].Tags[?Key=='Boot'].Value | [0]" --output text)" = "$BOOT" ] \
    || { echo "FAIL: $ID ran another infra/service-host-boot.sh; terminate it (aws ec2 terminate-instances --instance-ids $ID), then re-run" >&2; exit 1; }
  case $(aws ec2 describe-instances --instance-ids "$ID" --query 'Reservations[0].Instances[0].State.Name' --output text) in
    stopping|stopped)
      aws ec2 wait instance-stopped --instance-ids "$ID"
      aws ec2 start-instances --instance-ids "$ID" >/dev/null
      echo "started $ID";;
  esac
fi
aws ec2 wait instance-running --instance-ids "$ID"
[ "$(aws ec2 describe-addresses --allocation-ids "$ALLOC" --query 'Addresses[0].InstanceId' --output text)" = "$ID" ] \
  || aws ec2 associate-address --allocation-id "$ALLOC" --instance-id "$ID" >/dev/null

for _ in $(seq 1 40); do
  [ "$(aws ssm describe-instance-information --filters Key=InstanceIds,Values="$ID" \
    --query 'InstanceInformationList[0].PingStatus' --output text)" = Online ] && break
  sleep 15
done
INSTANCE=$NAME . "$HERE/on-host.sh"
# on_host waits about 100 s for a command, and a first boot's set-up can take longer, so ask again until it is done.
for _ in $(seq 1 10); do on_host 'cloud-init status --wait' >/dev/null 2>&1 && break; done
on_host 'cloud-init status || true' | grep -q 'status: done' || { echo "FAIL: the host's first-boot set-up did not finish; read /var/log/cloud-init-output.log on $ID" >&2; exit 1; }
on_host "$(sed "s/BUCKET/$BUCKET/g" "$HERE/service-update.sh")"
echo "hail service: $ID at https://$SITE/"
echo "close the window: aws ec2 stop-instances --instance-ids $ID --profile stopsignal --region $AWS_REGION"
