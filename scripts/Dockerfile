# Build context is ./scripts (not the repo root) — this image only needs
# the pipeline package and its Python deps. Build with:
#   docker build -f scripts/Dockerfile ./scripts
# or, as it is actually invoked, via the one-shot `ingest` service in
# docker-compose.prod.yml:
#   docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm ingest --all
#
# Single-purpose image (like db/Migrations/Dockerfile): its only job is to
# run `python -m scripts.pipeline` once as a scheduled tool invocation on
# the EC2 box (story 4.3 — the on-instance systemd timer replaces the old
# GitHub Actions cron + S3 sync). ENTRYPOINT is the pipeline CLI, so
# `docker compose run --rm ingest --all` appends `--all` as its argument.
#
# The build context is copied into /app/scripts/ so that, from WORKDIR
# /app, `scripts` resolves as a namespace package and `scripts.pipeline`
# is the package carrying __main__.py.
FROM python:3.11-slim

WORKDIR /app

# requirements first, then the rest — keeps the pip layer cached across
# edits to the pipeline source.
COPY requirements.txt /app/scripts/requirements.txt
RUN pip install --no-cache-dir -r /app/scripts/requirements.txt

COPY . /app/scripts/

ENTRYPOINT ["python", "-m", "scripts.pipeline"]
