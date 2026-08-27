#!/usr/bin/env bash
# infra/cicd/01-github-oidc-role.sh
#
# Creates the GitHub OIDC identity provider (if not already present in the
# account) and an IAM role that .github/workflows/deploy.yml assumes via
# aws-actions/configure-aws-credentials (role-to-assume), instead of any
# long-lived AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY secret. Two things
# make this safe to trust:
#   1. The role's trust policy Principal is the OIDC provider itself
#      (Federated, not a static AWS account/user) — only a token actually
#      issued by token.actions.githubusercontent.com can assume it.
#   2. The trust policy's Condition restricts the token's `sub` claim to
#      repo:seanerice/clt-bicycle-map:* — this exact repo, any ref/branch
#      within it, but NOT a wildcard across repos or orgs. A GitHub Actions
#      run from any other repo (even another repo in the same account/org)
#      cannot assume this role.
#
# Idempotent: every step describes-then-creates, so re-running this script
# after it has already succeeded does nothing new.
#
# Not run as part of story 8.4 — see infra/README.md. The role this
# script creates is not actually assumed by a real GitHub Actions run
# until story 8.7 (the workflow's first real run).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$SCRIPT_DIR/../lib.sh"

require_aws_cli
ACCOUNT_ID="$(account_id)"

# --- resource names specific to this script (not shared with backend/frontend) ---

GITHUB_ORG="seanerice"
GITHUB_REPO="clt-bicycle-map"
OIDC_PROVIDER_HOST="token.actions.githubusercontent.com"
OIDC_PROVIDER_URL="https://${OIDC_PROVIDER_HOST}"
OIDC_AUDIENCE="sts.amazonaws.com"
GITHUB_ACTIONS_ROLE_NAME="bikemap-github-actions-deploy-role"
GITHUB_ACTIONS_POLICY_NAME="bikemap-github-actions-deploy-permissions"

# --- IAM is a global service — no --region on any call in this script. ---

# --- 1. GitHub OIDC identity provider (account-wide; only one of these can
#        ever exist per URL, so check before creating rather than assuming
#        it's missing — another script/process may have created it already,
#        e.g. for an unrelated repo in the same account). ---

OIDC_PROVIDER_ARN=$(aws iam list-open-id-connect-providers \
  --query "OpenIDConnectProviderList[?ends_with(Arn, '/${OIDC_PROVIDER_HOST}')].Arn | [0]" \
  --output text)

if [ -z "$OIDC_PROVIDER_ARN" ] || [ "$OIDC_PROVIDER_ARN" = "None" ]; then
  echo "Creating GitHub OIDC identity provider for $OIDC_PROVIDER_HOST"

  # --thumbprint-list is a required CLI parameter, but as of AWS's 2023
  # update to IAM OIDC support, IAM no longer actually uses the supplied
  # thumbprint to validate GitHub's certificate chain — it validates
  # against its own library of trusted root CAs for known providers
  # (GitHub included) instead. The value only needs to be a
  # well-formed 40-character SHA-1 hex digest to pass client-side
  # validation.
  #
  # The previous value here was a commonly-copied 39-character string —
  # one hex digit short of the required 40 — which fails aws-cli's own
  # ParamValidation before the request is ever sent (caught by actually
  # running this script for real in story 8.7). Replaced with the real,
  # live root CA thumbprint for token.actions.githubusercontent.com's
  # current certificate chain (ISRG Root X1), fetched with:
  #   openssl s_client -servername token.actions.githubusercontent.com \
  #     -showcerts -connect token.actions.githubusercontent.com:443 \
  #     </dev/null 2>/dev/null | ...extract the last cert in the chain... \
  #     | openssl x509 -noout -fingerprint -sha1
  GITHUB_OIDC_THUMBPRINT="ab9d0263244dd0326eb67015705a667e79cfe998"

  OIDC_PROVIDER_ARN=$(aws iam create-open-id-connect-provider \
    --url "$OIDC_PROVIDER_URL" \
    --client-id-list "$OIDC_AUDIENCE" \
    --thumbprint-list "$GITHUB_OIDC_THUMBPRINT" \
    --tags "Key=$PROJECT_TAG_KEY,Value=$PROJECT_TAG_VALUE" \
    --query "OpenIDConnectProviderArn" --output text)
else
  echo "GitHub OIDC identity provider already exists: $OIDC_PROVIDER_ARN"
fi

# --- 2. IAM role, trusted only by this OIDC provider and scoped to this repo ---

# StringEquals on the fixed `aud` claim, StringLike on `sub` since it uses
# a trailing wildcard — repo:seanerice/clt-bicycle-map:* matches any
# ref/branch/pull_request within *this* repo only. This is the
# acceptance-criterion-critical part: no wildcard across repos or orgs.
TRUST_POLICY=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "${OIDC_PROVIDER_ARN}" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_PROVIDER_HOST}:aud": "${OIDC_AUDIENCE}"
        },
        "StringLike": {
          "${OIDC_PROVIDER_HOST}:sub": "repo:${GITHUB_ORG}/${GITHUB_REPO}:*"
        }
      }
    }
  ]
}
JSON
)

if aws iam get-role --role-name "$GITHUB_ACTIONS_ROLE_NAME" >/dev/null 2>&1; then
  echo "IAM role $GITHUB_ACTIONS_ROLE_NAME already exists — updating trust policy"
  aws iam update-assume-role-policy \
    --role-name "$GITHUB_ACTIONS_ROLE_NAME" \
    --policy-document "$TRUST_POLICY"
else
  echo "Creating IAM role $GITHUB_ACTIONS_ROLE_NAME"
  aws iam create-role \
    --role-name "$GITHUB_ACTIONS_ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" \
    --tags "Key=$PROJECT_TAG_KEY,Value=$PROJECT_TAG_VALUE" \
    >/dev/null
fi

# --- 3. Permissions policy: S3 read/write on the frontend bucket, CloudFront
#        lookup + invalidation, and SSM SendCommand/GetCommandInvocation.
#        Scoped as tightly as the deploy job's actual needs allow — see
#        the two honest gaps called out inline below (CloudFront
#        distribution ID and, less avoidably, GetCommandInvocation)
#        rather than falling back to a wildcard resource for convenience.
#
#        cloudfront:ListDistributions was missing entirely until story
#        8.7's first real deploy run failed on it — deploy.yml's "Look up
#        CloudFront distribution ID" step calls ListDistributions to find
#        the distribution by its Comment tag (the distribution ID itself
#        isn't known until 8.6 creates it, same reasoning as the
#        SsmSendCommand statement below), and nothing had granted it. ---
#
# The CloudFront distribution ID and the backend EC2 instance ID don't
# exist yet (created in stories 8.6 and 8.5, respectively) — this cannot
# be scoped to exact resource ARNs the way 01-iam-role.sh's S3 permission
# was. Where AWS's IAM condition support lets us avoid a bare wildcard
# anyway (SSM SendCommand's ssm:resourceTag/Name condition on the EC2
# instance resource), it's used below. Where it can't be avoided
# (CloudFront invalidation's distribution ID; ssm:GetCommandInvocation,
# which AWS does not support resource-level permissions on at all — see
# https://docs.aws.amazon.com/service-authorization/latest/reference/list_awssystemsmanager.html),
# that's called out as an acceptable, honest gap rather than faked with a
# made-up ID — tighten the CloudFront statement to the real distribution
# ARN once 8.6 creates it.
PERMISSIONS_POLICY=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListFrontendBucket",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::${FRONTEND_BUCKET_NAME}"
    },
    {
      "Sid": "ReadWriteFrontendBucketObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::${FRONTEND_BUCKET_NAME}/*"
    },
    {
      "Sid": "CloudFrontLookupAndInvalidateFrontendDistribution",
      "Effect": "Allow",
      "Action": [
        "cloudfront:ListDistributions",
        "cloudfront:CreateInvalidation",
        "cloudfront:GetInvalidation"
      ],
      "Resource": "*"
    },
    {
      "Sid": "SsmRunDeployDocument",
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": "arn:aws:ssm:${AWS_REGION}::document/AWS-RunShellScript"
    },
    {
      "Sid": "SsmSendCommandToTaggedBackendInstanceOnly",
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": "arn:aws:ec2:${AWS_REGION}:${ACCOUNT_ID}:instance/*",
      "Condition": {
        "StringEquals": {
          "ssm:resourceTag/Name": "${BACKEND_NAME}"
        }
      }
    },
    {
      "Sid": "SsmGetCommandInvocationStatus",
      "Effect": "Allow",
      "Action": "ssm:GetCommandInvocation",
      "Resource": "*"
    }
  ]
}
JSON
)

# put-role-policy is a PUT: re-running with the same policy name/document
# overwrites with identical content rather than piling up duplicates.
echo "Putting scoped inline policy $GITHUB_ACTIONS_POLICY_NAME on $GITHUB_ACTIONS_ROLE_NAME"
aws iam put-role-policy \
  --role-name "$GITHUB_ACTIONS_ROLE_NAME" \
  --policy-name "$GITHUB_ACTIONS_POLICY_NAME" \
  --policy-document "$PERMISSIONS_POLICY"

echo "Done. Role ARN (set as the AWS_DEPLOY_ROLE_ARN repo variable/secret used by .github/workflows/deploy.yml):"
aws iam get-role --role-name "$GITHUB_ACTIONS_ROLE_NAME" --query "Role.Arn" --output text
