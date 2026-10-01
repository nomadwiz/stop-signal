#!/usr/bin/env bash
# Creates the alarm that emails the owner when capture stops writing (#11, ADR-014): the SNS topic
# stopsignal-capture, an email subscription, and the alarm stopsignal-capture-heartbeat, which fires when
# the heartbeat that infra/capture-heartbeat.sh publishes sums below 1 for 3 one-minute periods, missing data breaching.
#
# Usage: infra/capture-alarm.sh <email>
#   Run from the build repository's root with the AWS CLI profile `stopsignal`. Safe to re-run: the topic
#   is reused, the address is subscribed only if it is not already, and the alarm is overwritten.
#   SNS emails a confirmation link; open it within 48 hours, or SNS deletes the subscription and you rerun this.
#   Then run infra/check-capture-alarm.sh.
set -euo pipefail
[ $# -eq 1 ] || { echo "Usage: infra/capture-alarm.sh <email>" >&2; exit 1; }
EMAIL=$1
export AWS_PROFILE=stopsignal AWS_REGION=ap-southeast-2
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
NAME=stopsignal-capture
ALARM=$NAME-heartbeat

TOPIC=$(aws sns create-topic --name "$NAME" --query TopicArn --output text)
# Only this alarm may publish to the topic, the scoping CloudWatch recommends against a confused deputy.
aws sns set-topic-attributes --topic-arn "$TOPIC" --attribute-name Policy --attribute-value "$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "cloudwatch.amazonaws.com" },
    "Action": "sns:Publish",
    "Resource": "$TOPIC",
    "Condition": {
      "ArnLike": { "aws:SourceArn": "arn:aws:cloudwatch:$AWS_REGION:$ACCOUNT:alarm:$ALARM" },
      "StringEquals": { "aws:SourceAccount": "$ACCOUNT" }
    }
  }]
}
EOF
)"

if [ -z "$(aws sns list-subscriptions-by-topic --topic-arn "$TOPIC" --query "Subscriptions[?Endpoint=='$EMAIL'].SubscriptionArn" --output text)" ]; then
  aws sns subscribe --topic-arn "$TOPIC" --protocol email --notification-endpoint "$EMAIL" >/dev/null
  echo "open the confirmation email sent to $EMAIL"
fi

aws cloudwatch put-metric-alarm --alarm-name "$ALARM" \
  --alarm-description "feed-capture has written no snapshot to /var/lib/stopsignal/archive for over 2 minutes (#11)" \
  --namespace StopSignal/Capture --metric-name Heartbeat --statistic Sum --period 60 \
  --evaluation-periods 3 --datapoints-to-alarm 3 --threshold 1 --comparison-operator LessThanThreshold \
  --treat-missing-data breaching --alarm-actions "$TOPIC"
echo "alarm $ALARM notifies $TOPIC"
