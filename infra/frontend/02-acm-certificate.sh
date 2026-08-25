#!/usr/bin/env bash
# infra/frontend/02-acm-certificate.sh
#
# Requests the ACM certificate for bikemap.seanerice.dev that
# 03-cloudfront-distribution.sh attaches to the distribution.
#
# IMPORTANT: this is requested in us-east-1 SPECIFICALLY (via
# $ACM_REGION, hardcoded in infra/lib.sh), regardless of $AWS_REGION or
# where the rest of infra/'s resources live. This isn't a stylistic
# choice — CloudFront only ever accepts ACM certificates issued in
# us-east-1, full stop, even for a distribution whose origin bucket (or
# the operator's own default region) is elsewhere. Hardcoding it (rather
# than deriving it from $AWS_REGION) means this script does the right
# thing even if someone runs the rest of infra/ with AWS_REGION set to
# something else.
#
# Idempotent: looks up an existing certificate for the domain in
# us-east-1 before requesting a new one.
#
# Usage notes:
#   - DNS validation is used (not email) because Cloudflare is the
#     domain's nameserver (deployment.md §1) and there's no Route 53
#     hosted zone to auto-validate against. After requesting, fetch the
#     validation CNAME and add it in the Cloudflare dashboard by hand —
#     that step isn't scriptable via aws-cli and happens in 8.5/8.6:
#       aws acm describe-certificate --region us-east-1 \
#         --certificate-arn <arn> \
#         --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
#
# Not run as part of story 8.2 — see infra/README.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$SCRIPT_DIR/../lib.sh"

require_aws_cli

EXISTING_ARN=$(aws acm list-certificates \
  --region "$ACM_REGION" \
  --query "CertificateSummaryList[?DomainName=='$FRONTEND_DOMAIN'].CertificateArn | [0]" \
  --output text)

if [ -n "$EXISTING_ARN" ] && [ "$EXISTING_ARN" != "None" ]; then
  echo "Certificate for $FRONTEND_DOMAIN already exists: $EXISTING_ARN"
  exit 0
fi

echo "Requesting ACM certificate for $FRONTEND_DOMAIN in $ACM_REGION"
CERT_ARN=$(aws acm request-certificate \
  --region "$ACM_REGION" \
  --domain-name "$FRONTEND_DOMAIN" \
  --validation-method DNS \
  --tags "Key=$PROJECT_TAG_KEY,Value=$PROJECT_TAG_VALUE" \
  --query "CertificateArn" --output text)

echo "Requested: $CERT_ARN"
echo "Next: fetch the DNS validation record and add it in Cloudflare:"
echo "  aws acm describe-certificate --region $ACM_REGION --certificate-arn $CERT_ARN --query 'Certificate.DomainValidationOptions[0].ResourceRecord'"
