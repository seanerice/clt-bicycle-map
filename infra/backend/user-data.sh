#!/bin/bash
# infra/backend/user-data.sh
#
# EC2 user-data for the bikemap backend instance (Amazon Linux 2023,
# arm64) — passed to 04-launch-instance.sh's `run-instances` call and
# run once at first boot via cloud-init.
#
# This installs Docker and the Compose plugin ONLY. It deliberately does
# NOT deploy the app itself (pulling images, running
# docker-compose.prod.yml, etc.) — that's story 8.3/8.4/8.7's job: the
# CI/CD workflow (8.4) drives deploys via `aws ssm send-command` against
# an already-provisioned, Docker-ready box.
set -euo pipefail

dnf update -y
dnf install -y docker

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
