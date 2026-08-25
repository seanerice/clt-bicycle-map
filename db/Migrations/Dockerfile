# Build context is the repo root (not db/Migrations/), matching
# api/Dockerfile's pattern for consistency — Migrations.csproj itself has
# no external project reference today, but the repo-root-context + COPY
# db/Migrations/... paths keep both Dockerfiles built the same way. Build
# with:
#   docker build -f db/Migrations/Dockerfile .
#
# Single-stage SDK image (not a slim runtime stage like api/Dockerfile's):
# this container only ever runs `dotnet ef database update` as a one-shot
# tool invocation, so there's no "runtime" half to split out — the SDK +
# dotnet-ef tool *is* the whole point of the image.
FROM mcr.microsoft.com/dotnet/sdk:8.0

WORKDIR /src

COPY db/Migrations/Migrations.csproj db/Migrations/Migrations.csproj
RUN dotnet restore db/Migrations/Migrations.csproj

COPY db/Migrations/ db/Migrations/

# Version pinned to match Microsoft.EntityFrameworkCore.Design in
# Migrations.csproj — keep these in sync if that package version changes.
RUN dotnet tool install --global dotnet-ef --version 8.0.11
ENV PATH="$PATH:/root/.dotnet/tools"

# WORKDIR here (post-copy, into the project directory) so `dotnet ef`
# resolves the project implicitly, without needing a --project flag.
WORKDIR /src/db/Migrations

ENTRYPOINT ["dotnet", "ef", "database", "update"]
