# Sourced, not run, by the infra/ scripts and the deploy job that act on the capture host: sets ID to the
# running instance tagged stopsignal-capture, or exits, and defines on_host.
#
# Usage: . infra/on-host.sh   (with AWS_REGION and credentials already set)

ID=$(aws ec2 describe-instances --filters Name=tag:Name,Values=stopsignal-capture Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].InstanceId' --output text)
[ -n "$ID" ] || { echo "FAIL: no running instance tagged stopsignal-capture" >&2; exit 1; }

# Runs a shell command on the instance through Systems Manager and prints its output and errors;
# fails if the command fails.
on_host() {
  local cmd status
  cmd=$(aws ssm send-command --instance-ids "$ID" --document-name AWS-RunShellScript \
    --parameters "$(jq -n --arg c "$1" '{commands: [$c]}')" --query Command.CommandId --output text)
  aws ssm wait command-executed --command-id "$cmd" --instance-id "$ID" 2>/dev/null || true
  status=$(aws ssm get-command-invocation --command-id "$cmd" --instance-id "$ID" --query Status --output text)
  aws ssm get-command-invocation --command-id "$cmd" --instance-id "$ID" \
    --query '[StandardOutputContent, StandardErrorContent]' --output text
  [ "$status" = Success ]
}
