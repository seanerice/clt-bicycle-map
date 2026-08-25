#!/usr/bin/env bash
# infra/backend/01-iam-role.sh
#
# Creates the IAM role + instance profile the backend EC2 instance
# (04-launch-instance.sh) assumes. Grants exactly three things, nothing
# broader:
#   1. The AWS-managed AmazonSSMManagedInstanceCore policy — SSM Session
#      Manager access, which is how the box is administered (no SSH, no
#      key pair — see 02-security-group.sh).
#   2. A scoped ssm:GetParameter permission on the POSTGRES_PASSWORD
#      parameter this same story's 03-ssm-parameter.sh creates.
#   3. A scoped s3:PutObject permission on s3://bikemap/db-backups/*
#      only (nightly pg_dump backups) — not the rest of the `bikemap`
#      bucket, and not a wildcard s3:*/ec2:* grant.
#
# Idempotent: every step describes-then-creates (or uses an API call
# that's a no-op/overwrite on repeat), so re-running this script after
# it has already succeeded does nothing new.
#
# Not run as part of story 8.1 — see infra/README.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$SCRIPT_DIR/../lib.sh"

require_aws_cli
ACCOUNT_ID="$(account_id)"

# IAM is a global service — no --region on any call in this script.

TRUST_POLICY=$(cat <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "ec2.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
JSON
)

if aws iam get-role --role-name "$IAM_ROLE_NAME" >/dev/null 2>&1; then
  echo "IAM role $IAM_ROLE_NAME already exists, skipping creation"
else
  echo "Creating IAM role $IAM_ROLE_NAME"
  aws iam create-role \
    --role-name "$IAM_ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" \
    --tags "Key=$PROJECT_TAG_KEY,Value=$PROJECT_TAG_VALUE" \
    >/dev/null
fi

# attach-role-policy is idempotent by nature: attaching an
# already-attached managed policy is a no-op, not an error.
echo "Attaching AmazonSSMManagedInstanceCore to $IAM_ROLE_NAME"
aws iam attach-role-policy \
  --role-name "$IAM_ROLE_NAME" \
  --policy-arn "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"

# Scoped, inline (not managed) policy: exactly ssm:GetParameter on the
# one parameter, and s3:PutObject on the one prefix. Nothing else.
SCOPED_POLICY=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadPostgresPasswordParameter",
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:${AWS_REGION}:${ACCOUNT_ID}:parameter${SSM_PARAM_NAME}"
    },
    {
      "Sid": "WriteDbBackupsToS3",
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::${DATA_BUCKET_NAME}/${DB_BACKUPS_PREFIX}/*"
    }
  ]
}
JSON
)

# put-role-policy is a PUT, not a POST: re-running with the same policy
# name and document is naturally idempotent — it overwrites with
# identical content rather than piling up duplicate policies the way a
# create-* call would.
echo "Putting scoped inline policy $IAM_SCOPED_POLICY_NAME on $IAM_ROLE_NAME"
aws iam put-role-policy \
  --role-name "$IAM_ROLE_NAME" \
  --policy-name "$IAM_SCOPED_POLICY_NAME" \
  --policy-document "$SCOPED_POLICY"

if aws iam get-instance-profile --instance-profile-name "$IAM_INSTANCE_PROFILE_NAME" >/dev/null 2>&1; then
  echo "Instance profile $IAM_INSTANCE_PROFILE_NAME already exists"
else
  echo "Creating instance profile $IAM_INSTANCE_PROFILE_NAME"
  aws iam create-instance-profile \
    --instance-profile-name "$IAM_INSTANCE_PROFILE_NAME" \
    --tags "Key=$PROJECT_TAG_KEY,Value=$PROJECT_TAG_VALUE" \
    >/dev/null
fi

ROLE_ALREADY_ATTACHED=$(aws iam get-instance-profile \
  --instance-profile-name "$IAM_INSTANCE_PROFILE_NAME" \
  --query "length(InstanceProfile.Roles[?RoleName=='${IAM_ROLE_NAME}'])" \
  --output text)

if [ "$ROLE_ALREADY_ATTACHED" = "0" ]; then
  echo "Adding role $IAM_ROLE_NAME to instance profile $IAM_INSTANCE_PROFILE_NAME"
  aws iam add-role-to-instance-profile \
    --instance-profile-name "$IAM_INSTANCE_PROFILE_NAME" \
    --role-name "$IAM_ROLE_NAME"
else
  echo "Role already attached to instance profile, skipping"
fi

echo "Done. Instance profile ARN:"
aws iam get-instance-profile \
  --instance-profile-name "$IAM_INSTANCE_PROFILE_NAME" \
  --query "InstanceProfile.Arn" --output text
