#!/usr/bin/env bash
# infra/backend/04-launch-instance.sh
#
# Launches the backend t3a.micro instance (Amazon Linux 2023, x86_64,
# AMD), attached to the IAM instance profile from 01-iam-role.sh and the
# security group from 02-security-group.sh, with user-data.sh installing
# Docker + the Compose plugin at boot. No --key-name is passed anywhere
# in this script — SSH is never available on this box (see
# 02-security-group.sh); the only way in is SSM Session Manager, via the
# AmazonSSMManagedInstanceCore role.
#
# x86_64, not the originally-planned arm64/t4g.micro — see lib.sh's
# INSTANCE_TYPE comment for why (postgis/postgis has no arm64 build at
# all, discovered by actually running story 8.7's deploy for real).
#
# --credit-specification CpuCredits=standard is passed explicitly rather
# than left at the API default, per deployment.md §3 ("Leave CPU credit
# mode on Standard ... not Unlimited") — Standard is free and plenty for
# this workload; Unlimited can bill extra for sustained bursts above the
# t3a.micro's baseline.
#
# Idempotent: looks up a pending/running/stopping/stopped instance
# tagged Name=$BACKEND_NAME before launching a new one.
#
# Usage notes:
#   - Run 01-iam-role.sh, 02-security-group.sh, and 03-ssm-parameter.sh
#     first — this script looks up their output by name/tag rather than
#     taking it as arguments.
#   - Before actually launching (story 8.5, not this one), sanity-check
#     credentials/parameters with no side effects at all:
#       DRY_RUN=1 ./04-launch-instance.sh
#     This adds --dry-run to the run-instances call, which validates IAM
#     permissions and request parameters and always returns an error —
#     either "DryRunOperation" (meaning everything checks out) or the
#     real permissions/parameter error — without creating anything.
#
# Not run as part of story 8.1 — see infra/README.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$SCRIPT_DIR/../lib.sh"

require_aws_cli

# Git Bash / MSYS on Windows auto-converts CLI arguments that look like
# absolute POSIX paths into Windows paths before exec'ing aws-cli (e.g.
# "/aws/service/..." becomes "C:/Program Files/Git/aws/service/..."),
# which breaks the AMI lookup below since its --names value starts with
# a slash. Excluding it from conversion is a no-op outside of
# MSYS/Git-Bash (Linux/Mac/WSL), so it's always safe to set.
export MSYS2_ARG_CONV_EXCL="/aws/service"

EXISTING_ID=$(aws ec2 describe-instances \
  --region "$AWS_REGION" \
  --filters "Name=tag:Name,Values=$BACKEND_NAME" \
            "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query "Reservations[0].Instances[0].InstanceId" --output text)

if [ -n "$EXISTING_ID" ] && [ "$EXISTING_ID" != "None" ]; then
  echo "Instance already exists: $EXISTING_ID, skipping launch"
  exit 0
fi

VPC_ID=$(aws ec2 describe-vpcs \
  --region "$AWS_REGION" \
  --filters "Name=isDefault,Values=true" \
  --query "Vpcs[0].VpcId" --output text)

SG_ID=$(aws ec2 describe-security-groups \
  --region "$AWS_REGION" \
  --filters "Name=group-name,Values=$SECURITY_GROUP_NAME" "Name=vpc-id,Values=$VPC_ID" \
  --query "SecurityGroups[0].GroupId" --output text)

if [ -z "$SG_ID" ] || [ "$SG_ID" = "None" ]; then
  echo "error: security group $SECURITY_GROUP_NAME not found — run 02-security-group.sh first" >&2
  exit 1
fi

# Latest Amazon Linux 2023 x86_64 AMI, resolved via AWS's public SSM
# parameter rather than hardcoded, so this script doesn't go stale as
# new AMIs are published.
AMI_ID=$(aws ssm get-parameters \
  --region "$AWS_REGION" \
  --names "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64" \
  --query "Parameters[0].Value" --output text)

if [ -z "$AMI_ID" ] || [ "$AMI_ID" = "None" ]; then
  echo "error: could not resolve the Amazon Linux 2023 x86_64 AMI" >&2
  exit 1
fi

# Note the no-subnet-id approach here: we intentionally rely on the
# default VPC's default subnet (EC2 auto-selects one when none is given
# and the account has a default VPC), matching this project's
# "default VPC only, no custom VPC" stance (deployment.md §2).

DRY_RUN_FLAG=()
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "DRY_RUN=1: passing --dry-run (validates only, creates nothing)"
  DRY_RUN_FLAG=(--dry-run)
fi

USER_DATA_FILE="$(to_file_uri_path "$SCRIPT_DIR/user-data.sh")"

echo "Launching $INSTANCE_TYPE instance from $AMI_ID"
aws ec2 run-instances \
  --region "$AWS_REGION" \
  ${DRY_RUN_FLAG[@]+"${DRY_RUN_FLAG[@]}"} \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --iam-instance-profile "Name=$IAM_INSTANCE_PROFILE_NAME" \
  --security-group-ids "$SG_ID" \
  --credit-specification CpuCredits=standard \
  --user-data "file://$USER_DATA_FILE" \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":20,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$BACKEND_NAME},{Key=$PROJECT_TAG_KEY,Value=$PROJECT_TAG_VALUE}]" \
  --count 1

echo "Done."
