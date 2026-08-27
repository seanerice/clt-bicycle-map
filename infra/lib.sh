# infra/lib.sh
#
# Shared constants and small helpers sourced by every script under
# infra/backend/ and infra/frontend/. Not meant to be run directly (it
# has no shebang and does nothing on its own — `source` it).
#
# IMPORTANT: these scripts are written and statically verified only, as
# part of stories 8.1/8.2 (see infra/README.md). They are not executed
# against the real AWS account until stories 8.5/8.6.

# Region backend resources (EC2, security group, IAM, SSM parameter)
# live in. Matches the existing legacy EC2 box's region
# (docs/planning/deployment.md §1), so this lines up with whatever
# region the operator's aws-cli is already pointed at. Override with:
#   AWS_REGION=us-west-2 ./01-iam-role.sh
AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION

# Every resource these scripts create is tagged with this, so it's easy
# to find/audit later, and so idempotent lookups can filter on it rather
# than hardcoding resource IDs.
PROJECT_TAG_KEY="Project"
PROJECT_TAG_VALUE="bikemap"

# --- Backend (story 8.1) resource names ---
BACKEND_NAME="bikemap-backend"
IAM_ROLE_NAME="bikemap-backend-role"
IAM_INSTANCE_PROFILE_NAME="bikemap-backend-instance-profile"
IAM_SCOPED_POLICY_NAME="bikemap-backend-scoped-permissions"
SECURITY_GROUP_NAME="bikemap-backend-sg"
SSM_PARAM_NAME="/bikemap/prod/POSTGRES_PASSWORD"
EIP_NAME="bikemap-backend-eip"
# x86_64 (AMD), not the originally-planned t4g.micro (arm64/Graviton) —
# changed during story 8.7 after discovering, by actually running the
# real deploy, that postgis/postgis (the db service's image since Epic
# 1) publishes no arm64 build at all across any of its ~160 tags. Local
# dev and CI never caught this because they run on x86 machines. t3a
# (AMD) rather than t3 (Intel) for the same "cheapest option" reasoning
# deployment.md originally applied to picking t4g over t3 — ~$6.86/mo
# vs. t4g.micro's ~$6.13/mo, a real but small cost increase, still
# cheaper than t3.micro. See deployment.md §3 for the full writeup.
INSTANCE_TYPE="t3a.micro"

# The EXISTING data-pipeline bucket (unchanged, out of scope — see
# CLAUDE.md / deployment.md §1). The backend instance role is scoped to
# write only under db-backups/ in this bucket for nightly pg_dump
# uploads. This is NOT the frontend bucket below — that's a different,
# new bucket story 8.2 creates.
DATA_BUCKET_NAME="bikemap"
DB_BACKUPS_PREFIX="db-backups"

# --- Frontend (story 8.2) resource names ---
FRONTEND_BUCKET_NAME="bikemap-frontend"
FRONTEND_DOMAIN="bikemap.seanerice.dev"
CLOUDFRONT_COMMENT="bikemap-frontend"
OAC_NAME="bikemap-frontend-oac"

# CloudFront requires ACM certificates to be requested in us-east-1
# specifically, no matter what region the distribution, the bucket, or
# $AWS_REGION above are. This is hardcoded (not derived from
# $AWS_REGION) so the frontend scripts do the right thing even if
# someone runs the rest of infra/ with AWS_REGION set elsewhere. See
# infra/frontend/02-acm-certificate.sh for the long version.
ACM_REGION="us-east-1"

# On Windows Git Bash, a `file://$path` value embeds a POSIX-style path
# (e.g. /c/Users/...) inside a URI scheme, which MSYS's automatic
# path-conversion never rewrites (it only converts bare path-looking
# arguments, not ones embedded after "file://"), so aws-cli fails to open
# the file. cygpath -m (Git Bash/Cygwin/MSYS only) gives the
# Windows-style equivalent aws-cli can actually load; cygpath doesn't
# exist on Linux/Mac, so this is a no-op there and the path is returned
# unchanged.
to_file_uri_path() {
  local path="$1"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$path"
  else
    printf '%s' "$path"
  fi
}

require_aws_cli() {
  if ! command -v aws >/dev/null 2>&1; then
    echo "error: aws-cli not found on PATH" >&2
    exit 1
  fi
}

# Prints the caller's AWS account ID. Used to build fully-qualified ARNs
# for scoped IAM/S3 policies.
account_id() {
  aws sts get-caller-identity --query Account --output text
}
