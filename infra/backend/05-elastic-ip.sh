#!/usr/bin/env bash
# infra/backend/05-elastic-ip.sh
#
# Allocates an Elastic IP and associates it with the backend instance, so
# bikemap-api.seanerice.dev doesn't need to change if the instance ever
# stops/starts (deployment.md §3) — unlike the current legacy box, whose
# public IP is a non-guaranteed auto-assigned address.
#
# Idempotent: looks up an existing EIP by tag before allocating a new
# one, and checks whether it's already associated with the target
# instance before re-associating.
#
# Usage notes:
#   - Run 04-launch-instance.sh first — this script looks up the
#     instance by its Name tag.
#
# Not run as part of story 8.1 — see infra/README.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$SCRIPT_DIR/../lib.sh"

require_aws_cli

INSTANCE_ID=$(aws ec2 describe-instances \
  --region "$AWS_REGION" \
  --filters "Name=tag:Name,Values=$BACKEND_NAME" \
            "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query "Reservations[0].Instances[0].InstanceId" --output text)

if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
  echo "error: no $BACKEND_NAME instance found — run 04-launch-instance.sh first" >&2
  exit 1
fi

ALLOCATION_ID=$(aws ec2 describe-addresses \
  --region "$AWS_REGION" \
  --filters "Name=tag:Name,Values=$EIP_NAME" \
  --query "Addresses[0].AllocationId" --output text)

if [ -z "$ALLOCATION_ID" ] || [ "$ALLOCATION_ID" = "None" ]; then
  echo "Allocating new Elastic IP"
  ALLOCATION_ID=$(aws ec2 allocate-address \
    --region "$AWS_REGION" \
    --domain vpc \
    --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$EIP_NAME},{Key=$PROJECT_TAG_KEY,Value=$PROJECT_TAG_VALUE}]" \
    --query "AllocationId" --output text)
else
  echo "Elastic IP already allocated: $ALLOCATION_ID"
fi

CURRENT_INSTANCE=$(aws ec2 describe-addresses \
  --region "$AWS_REGION" \
  --allocation-ids "$ALLOCATION_ID" \
  --query "Addresses[0].InstanceId" --output text)

if [ "$CURRENT_INSTANCE" = "$INSTANCE_ID" ]; then
  echo "Already associated with $INSTANCE_ID, skipping"
else
  echo "Associating $ALLOCATION_ID with $INSTANCE_ID"
  aws ec2 associate-address \
    --region "$AWS_REGION" \
    --instance-id "$INSTANCE_ID" \
    --allocation-id "$ALLOCATION_ID" \
    >/dev/null
fi

echo "Done. Public IP:"
aws ec2 describe-addresses \
  --region "$AWS_REGION" \
  --allocation-ids "$ALLOCATION_ID" \
  --query "Addresses[0].PublicIp" --output text
