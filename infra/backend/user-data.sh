#!/bin/bash
# infra/backend/user-data.sh
#
# EC2 user-data for the bikemap backend instance (Amazon Linux 2023,
# arm64) — passed to 04-launch-instance.sh's `run-instances` call and
# run once at first boot via cloud-init.
#
# This installs Docker, the Compose plugin, and git, clones this public
# repo to /opt/bikemap, and writes /opt/bikemap/.env with the real
# POSTGRES_PASSWORD (fetched from SSM Parameter Store via this
# instance's own IAM role — see 01-iam-role.sh's scoped ssm:GetParameter
# grant) so `docker compose` picks it up automatically for the
# ${POSTGRES_PASSWORD} substitutions in docker-compose.yml. Per
# deployment.md §3 ("fetched into a .env file by the instance at boot").
# It deliberately does NOT deploy the app itself (pulling images,
# running docker-compose.prod.yml, etc.) — that's story 8.3/8.4/8.7's
# job: the CI/CD workflow (8.4) drives deploys via `aws ssm send-command`
# against an already-provisioned, Docker-ready box, and expects
# /opt/bikemap to already hold a checkout it can `cd` into and `git
# reset --hard` to the deployed commit (see deploy.yml).
set -euo pipefail

dnf update -y
dnf install -y docker git

systemctl enable --now docker
usermod -aG docker ec2-user

# Amazon Linux 2023's `docker` package doesn't bundle the Compose v2
# plugin. Install it as a CLI plugin so `docker compose ...` (the
# subcommand form docker-compose.yml is invoked with elsewhere in this
# repo) works, rather than the standalone `docker-compose` binary.
mkdir -p /usr/local/lib/docker/cli-plugins
curl -SL \
  "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-aarch64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Public repo, no auth needed. --branch v2 because this whole migration
# (Epics 1-8) has been developed as a stack of PRs against `v2`, which
# has never merged into `main` (see .github/workflows/deploy.yml's header
# comment) — cloning the default branch would check out pre-migration
# code with none of this present. Idempotent in spirit even though
# user-data only ever runs once per instance at first boot — guarding on
# the directory not existing keeps this safe to hand-reproduce in a
# shell too.
if [ ! -d /opt/bikemap/.git ]; then
  git clone --branch v2 https://github.com/seanerice/clt-bicycle-map.git /opt/bikemap
fi

# docker compose reads a .env file in its working directory automatically
# for ${VAR} substitution — no explicit --env-file flag needed anywhere
# else in this repo's compose invocations. Guarding on the file not
# existing keeps this safe to hand-reproduce in a shell too, and (unlike
# the git clone above) matters even after user-data's one-time run: .env
# is gitignored, so it survives `git reset --hard` deploys untouched,
# but a box that predates this script change needs it created once.
if [ ! -f /opt/bikemap/.env ]; then
  POSTGRES_PASSWORD="$(aws ssm get-parameter --region us-east-1 --name /bikemap/prod/POSTGRES_PASSWORD --with-decryption --query Parameter.Value --output text)"
  echo "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}" > /opt/bikemap/.env
  chmod 600 /opt/bikemap/.env
  unset POSTGRES_PASSWORD
fi
