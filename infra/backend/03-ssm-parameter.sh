#!/usr/bin/env bash
# infra/backend/03-ssm-parameter.sh
#
# Creates the SSM SecureString parameter holding POSTGRES_PASSWORD. The
# backend instance reads it at deploy time via the scoped
# ssm:GetParameter permission 01-iam-role.sh grants. No GHCR pull token
# parameter is created here — the api image's GHCR repo is public
# (deployment.md §6), so nothing is needed to pull it.
#
# Idempotent: only creates the parameter if it doesn't already exist. It
# deliberately does NOT overwrite an existing value on re-run, so this
# script can never clobber a password already in use by a live database.
#
# Not run as part of story 8.1 — see infra/README.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$SCRIPT_DIR/../lib.sh"

require_aws_cli

# Git Bash / MSYS on Windows auto-converts CLI arguments that look like
# absolute POSIX paths into Windows paths before exec'ing aws-cli (e.g.
# "/bikemap/prod/..." becomes "C:/Program Files/Git/bikemap/prod/..."),
# which breaks any AWS resource name that happens to start with a slash,
# like this SSM parameter name. Excluding it from conversion is a no-op
# outside of MSYS/Git-Bash (Linux/Mac/WSL), so it's always safe to set.
export MSYS2_ARG_CONV_EXCL="$SSM_PARAM_NAME"

if aws ssm get-parameter --region "$AWS_REGION" --name "$SSM_PARAM_NAME" >/dev/null 2>&1; then
  echo "Parameter $SSM_PARAM_NAME already exists, leaving its value untouched"
  exit 0
fi

# Use POSTGRES_PASSWORD from the environment if the caller supplied one
# (e.g. to carry over an existing local .env value during migration);
# otherwise generate a random one locally with openssl (no extra AWS
# permission needed beyond ssm:PutParameter). Either way, the value is
# never echoed or logged by this script.
if [ -n "${POSTGRES_PASSWORD:-}" ]; then
  PASSWORD_VALUE="$POSTGRES_PASSWORD"
else
  # Alphanumeric only, so the value is always safe to drop into a .env
  # file or a shell command line without quoting surprises.
  PASSWORD_VALUE=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | cut -c1-32)
fi

echo "Creating SecureString parameter $SSM_PARAM_NAME"
aws ssm put-parameter \
  --region "$AWS_REGION" \
  --name "$SSM_PARAM_NAME" \
  --type SecureString \
  --value "$PASSWORD_VALUE" \
  --tags "Key=$PROJECT_TAG_KEY,Value=$PROJECT_TAG_VALUE" \
  >/dev/null

unset PASSWORD_VALUE

echo "Done. Parameter created (value not printed)."
