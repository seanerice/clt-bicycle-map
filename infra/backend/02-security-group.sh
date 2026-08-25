#!/usr/bin/env bash
# infra/backend/02-security-group.sh
#
# Creates the security group for the backend EC2 instance. Opens ONLY
# 80 and 443 inbound from 0.0.0.0/0 — nothing else, ever. In particular:
# no port 22. SSH is intentionally never possible on this box;
# administration is via AWS Systems Manager Session Manager (granted by
# 01-iam-role.sh's AmazonSSMManagedInstanceCore attachment), not a key
# pair — no key pair is created or referenced anywhere in infra/.
#
# Idempotent: looks up the default VPC and an existing group by name
# before creating either; each ingress rule is added only if an
# equivalent rule doesn't already exist.
#
# Not run as part of story 8.1 — see infra/README.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$SCRIPT_DIR/../lib.sh"

require_aws_cli

VPC_ID=$(aws ec2 describe-vpcs \
  --region "$AWS_REGION" \
  --filters "Name=isDefault,Values=true" \
  --query "Vpcs[0].VpcId" --output text)

if [ -z "$VPC_ID" ] || [ "$VPC_ID" = "None" ]; then
  echo "error: no default VPC found in $AWS_REGION (this project intentionally uses only the default VPC)" >&2
  exit 1
fi

SG_ID=$(aws ec2 describe-security-groups \
  --region "$AWS_REGION" \
  --filters "Name=group-name,Values=$SECURITY_GROUP_NAME" "Name=vpc-id,Values=$VPC_ID" \
  --query "SecurityGroups[0].GroupId" --output text)

if [ -z "$SG_ID" ] || [ "$SG_ID" = "None" ]; then
  echo "Creating security group $SECURITY_GROUP_NAME in $VPC_ID"
  SG_ID=$(aws ec2 create-security-group \
    --region "$AWS_REGION" \
    --group-name "$SECURITY_GROUP_NAME" \
    --description "bikemap backend: inbound 80/443 only, no SSH" \
    --vpc-id "$VPC_ID" \
    --tag-specifications "ResourceType=security-group,Tags=[{Key=Name,Value=$SECURITY_GROUP_NAME},{Key=$PROJECT_TAG_KEY,Value=$PROJECT_TAG_VALUE}]" \
    --query "GroupId" --output text)
else
  echo "Security group $SECURITY_GROUP_NAME already exists: $SG_ID"
fi

# Adds an inbound TCP rule from 0.0.0.0/0 for one port, only if an
# equivalent rule isn't already present. This function is the ONLY place
# ingress rules are added in this script, and it is called exactly twice
# below (80, 443). Do not add a call for port 22 or any other port here.
authorize_http_port() {
  local port="$1"
  local existing
  existing=$(aws ec2 describe-security-groups \
    --region "$AWS_REGION" \
    --group-ids "$SG_ID" \
    --query "SecurityGroups[0].IpPermissions[?FromPort==\`$port\` && ToPort==\`$port\` && IpProtocol=='tcp']" \
    --output text)

  if [ -n "$existing" ]; then
    echo "Ingress rule for tcp/$port already present, skipping"
    return
  fi

  echo "Authorizing inbound tcp/$port from 0.0.0.0/0"
  aws ec2 authorize-security-group-ingress \
    --region "$AWS_REGION" \
    --group-id "$SG_ID" \
    --protocol tcp \
    --port "$port" \
    --cidr 0.0.0.0/0 \
    >/dev/null
}

authorize_http_port 80
authorize_http_port 443

echo "Done. Security group ID: $SG_ID"
