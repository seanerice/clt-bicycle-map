#!/usr/bin/env bash
# infra/frontend/01-s3-bucket.sh
#
# Creates the new frontend S3 bucket — separate from, and independent
# of, the existing `bikemap` data-pipeline bucket that infra/backend/
# scripts reference — and blocks all public access on it, matching that
# existing bucket's posture. The only reader is CloudFront, via an
# Origin Access Control (03-cloudfront-distribution.sh), not a public
# bucket policy and not S3 static-website-hosting mode.
#
# Idempotent: checks whether the bucket exists (head-bucket) before
# creating it; the public-access-block call is a PUT and safe to re-run.
#
# Not run as part of story 8.2 — see infra/README.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$SCRIPT_DIR/../lib.sh"

require_aws_cli

if aws s3api head-bucket --bucket "$FRONTEND_BUCKET_NAME" 2>/dev/null; then
  echo "Bucket $FRONTEND_BUCKET_NAME already exists, skipping creation"
else
  echo "Creating bucket $FRONTEND_BUCKET_NAME in $AWS_REGION"
  if [ "$AWS_REGION" = "us-east-1" ]; then
    # us-east-1 is the one region where create-bucket REJECTS an
    # explicit LocationConstraint — omit it there, pass it everywhere
    # else.
    aws s3api create-bucket \
      --bucket "$FRONTEND_BUCKET_NAME" \
      --region "$AWS_REGION"
  else
    aws s3api create-bucket \
      --bucket "$FRONTEND_BUCKET_NAME" \
      --region "$AWS_REGION" \
      --create-bucket-configuration "LocationConstraint=$AWS_REGION"
  fi
  aws s3api put-bucket-tagging \
    --bucket "$FRONTEND_BUCKET_NAME" \
    --tagging "TagSet=[{Key=$PROJECT_TAG_KEY,Value=$PROJECT_TAG_VALUE}]"
fi

echo "Blocking all public access on $FRONTEND_BUCKET_NAME"
aws s3api put-public-access-block \
  --bucket "$FRONTEND_BUCKET_NAME" \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

echo "Done."
