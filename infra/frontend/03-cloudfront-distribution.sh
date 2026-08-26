#!/usr/bin/env bash
# infra/frontend/03-cloudfront-distribution.sh
#
# Creates a CloudFront distribution in front of the frontend S3 bucket
# (01-s3-bucket.sh), using an Origin Access Control (OAC) — not a public
# bucket policy, and not a legacy Origin Access Identity (OAI) — as the
# only way anything reads the bucket. Attaches the ACM certificate from
# 02-acm-certificate.sh for the bikemap.seanerice.dev alias.
#
# The bucket policy this script applies at the end grants read access
# to the `cloudfront.amazonaws.com` service principal, scoped by an
# AWS:SourceArn condition to this one distribution's ARN. That is NOT a
# "public bucket policy" in the sense the acceptance criteria rule out
# (Principal: "*") — it's the specific, narrow policy AWS's OAC
# mechanism requires S3 to have in order to authenticate CloudFront's
# signed requests; the bucket's public-access-block settings (from
# 01-s3-bucket.sh) stay fully enabled throughout.
#
# Idempotent: looks up an existing OAC by name and an existing
# distribution by its Comment before creating either. The final
# bucket-policy step is a PUT and safe to re-run.
#
# Usage notes:
#   - Run 01-s3-bucket.sh and 02-acm-certificate.sh first.
#   - This script only requires the ACM certificate to exist (to attach
#     its ARN) — it does not wait for Status=ISSUED. The certificate
#     must actually be validated before CloudFront will serve traffic on
#     the alias, but that validation happens by hand in Cloudflare (see
#     02-acm-certificate.sh's usage notes) as part of story 8.5/8.6, not
#     here.
#
# Not run as part of story 8.2 — see infra/README.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$SCRIPT_DIR/../lib.sh"

require_aws_cli
ACCOUNT_ID="$(account_id)"

# --- resolve inputs from the earlier scripts ---

BUCKET_LOCATION=$(aws s3api get-bucket-location \
  --bucket "$FRONTEND_BUCKET_NAME" \
  --query "LocationConstraint" --output text)
if [ "$BUCKET_LOCATION" = "None" ] || [ "$BUCKET_LOCATION" = "null" ]; then
  # get-bucket-location returns null/None for us-east-1 specifically.
  BUCKET_LOCATION="us-east-1"
fi
BUCKET_REGIONAL_DOMAIN="${FRONTEND_BUCKET_NAME}.s3.${BUCKET_LOCATION}.amazonaws.com"

CERT_ARN=$(aws acm list-certificates \
  --region "$ACM_REGION" \
  --query "CertificateSummaryList[?DomainName=='$FRONTEND_DOMAIN'].CertificateArn | [0]" \
  --output text)
if [ -z "$CERT_ARN" ] || [ "$CERT_ARN" = "None" ]; then
  echo "error: no ACM certificate for $FRONTEND_DOMAIN in $ACM_REGION — run 02-acm-certificate.sh first" >&2
  exit 1
fi

# --- Origin Access Control ---
# CloudFront is a global service — none of the cloudfront calls below
# take --region.

OAC_ID=$(aws cloudfront list-origin-access-controls \
  --query "OriginAccessControlList.Items[?Name=='$OAC_NAME'].Id | [0]" \
  --output text)

if [ -z "$OAC_ID" ] || [ "$OAC_ID" = "None" ]; then
  echo "Creating Origin Access Control $OAC_NAME"
  OAC_ID=$(aws cloudfront create-origin-access-control \
    --origin-access-control-config "Name=$OAC_NAME,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3" \
    --query "OriginAccessControl.Id" --output text)
else
  echo "Origin Access Control already exists: $OAC_ID"
fi

# --- Distribution ---

EXISTING_DIST_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='$CLOUDFRONT_COMMENT'].Id | [0]" \
  --output text)

if [ -n "$EXISTING_DIST_ID" ] && [ "$EXISTING_DIST_ID" != "None" ]; then
  echo "Distribution already exists: $EXISTING_DIST_ID"
  DIST_ID="$EXISTING_DIST_ID"
else
  echo "Creating CloudFront distribution for $BUCKET_REGIONAL_DOMAIN"

  # AWS's managed "CachingOptimized" cache policy — a fixed, well-known
  # ID (not account-specific), documented at
  # https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html
  CACHING_OPTIMIZED_POLICY_ID="658327ea-f89d-4fab-a63d-7e88639e58f6"

  DIST_CONFIG_FILE=$(mktemp)
  trap 'rm -f "$DIST_CONFIG_FILE"' EXIT

  # NOTE: the file content for --distribution-config-with-tags IS the
  # DistributionConfigWithTags shape directly ({DistributionConfig, Tags}
  # at the top level) — it must NOT be wrapped in an extra outer
  # "DistributionConfigWithTags" key, even though that's what the shape's
  # own name might suggest. Confirmed against a real ParamValidation
  # error: aws-cli rejected the wrapped form with "Missing required
  # parameter in DistributionConfigWithTags: DistributionConfig" /
  # "Unknown parameter ...: DistributionConfigWithTags".
  cat > "$DIST_CONFIG_FILE" <<JSON
{
  "DistributionConfig": {
    "CallerReference": "$CLOUDFRONT_COMMENT",
    "Comment": "$CLOUDFRONT_COMMENT",
    "Enabled": true,
    "DefaultRootObject": "index.html",
    "Aliases": {
      "Quantity": 1,
      "Items": ["$FRONTEND_DOMAIN"]
    },
    "Origins": {
      "Quantity": 1,
      "Items": [
        {
          "Id": "$FRONTEND_BUCKET_NAME",
          "DomainName": "$BUCKET_REGIONAL_DOMAIN",
          "OriginAccessControlId": "$OAC_ID",
          "S3OriginConfig": {
            "OriginAccessIdentity": ""
          }
        }
      ]
    },
    "DefaultCacheBehavior": {
      "TargetOriginId": "$FRONTEND_BUCKET_NAME",
      "ViewerProtocolPolicy": "redirect-to-https",
      "CachePolicyId": "$CACHING_OPTIMIZED_POLICY_ID",
      "Compress": true
    },
    "ViewerCertificate": {
      "ACMCertificateArn": "$CERT_ARN",
      "SSLSupportMethod": "sni-only",
      "MinimumProtocolVersion": "TLSv1.2_2021"
    }
  },
  "Tags": {
    "Items": [
      { "Key": "$PROJECT_TAG_KEY", "Value": "$PROJECT_TAG_VALUE" }
    ]
  }
}
JSON

  DIST_ID=$(aws cloudfront create-distribution-with-tags \
    --distribution-config-with-tags "file://$(to_file_uri_path "$DIST_CONFIG_FILE")" \
    --query "Distribution.Id" --output text)

  rm -f "$DIST_CONFIG_FILE"
  trap - EXIT
fi

DIST_ARN="arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${DIST_ID}"

# --- bucket policy: only this distribution (via its OAC) may read the bucket ---

BUCKET_POLICY_FILE=$(mktemp)
trap 'rm -f "$BUCKET_POLICY_FILE"' EXIT

cat > "$BUCKET_POLICY_FILE" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontOACRead",
      "Effect": "Allow",
      "Principal": { "Service": "cloudfront.amazonaws.com" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::${FRONTEND_BUCKET_NAME}/*",
      "Condition": {
        "StringEquals": { "AWS:SourceArn": "$DIST_ARN" }
      }
    }
  ]
}
JSON

echo "Applying bucket policy scoped to distribution $DIST_ID"
aws s3api put-bucket-policy \
  --bucket "$FRONTEND_BUCKET_NAME" \
  --policy "file://$(to_file_uri_path "$BUCKET_POLICY_FILE")"

rm -f "$BUCKET_POLICY_FILE"
trap - EXIT

echo "Done. Distribution ID: $DIST_ID"
echo "Distribution domain name:"
aws cloudfront get-distribution --id "$DIST_ID" --query "Distribution.DomainName" --output text
