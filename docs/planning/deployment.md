# Deployment plan

Status: Draft for review
Owner: Sean Rice
Last updated: 2026-08-25

Deployment was explicitly deferred out of [epics.md §3](./epics.md#3-explicitly-not-epics) and parked in [testing-and-tooling.md §3](./testing-and-tooling.md#3-deployment) as "its own conversation." This is that conversation. It's overdue in a specific way: Epic 3 (merged to `main` as of this doc) replaced the frontend's static-S3-GeoJSON source with live `moveend`-triggered fetches against the API. The site can no longer run on the old "sync GeoJSON to S3" path alone — it needs a reachable API backed by a loaded PostGIS database to render anything.

## 1. Current state (account audit, 2026-08-25)

Before planning anything new, we checked what's actually running in the AWS account (`375300855067`, personal account, no AWS SSO/Identity Center):

| Resource | Detail |
|---|---|
| EC2 instance `i-08cd4f6c4a4106a78` | `t2.micro`, us-east-1, running since 2023-10-11, key pair `bikemap-site-key`, public IP `54.160.163.28` (not an Elastic IP — not guaranteed stable). This is the current live frontend host — plain EC2, no containers, predates Epics 1-3. |
| Security group `sg-087091be2c5f96f83` (`launch-wizard-1`) | Inbound 80/443 open to `0.0.0.0/0`; SSH (22) restricted to `76.244.16.202/32`, a possibly-stale allowlist entry. |
| S3 bucket `bikemap` (us-east-2) | The data pipeline target — unchanged from `CLAUDE.md`'s description, fed daily by `.github/workflows/osm-refresh.yml`. |
| CloudFront distribution `E27BZDOG02ZLBY` | Origin `bikemap.s3.us-east-2.amazonaws.com`, alias `data.bikemap.seanerice.dev`. |
| DNS | Cloudflare is the nameserver for `seanerice.dev`. `bikemap.seanerice.dev` resolves to Cloudflare's anycast IPs — proxied (orange-cloud) straight to the EC2 box above. `data.bikemap.seanerice.dev` is a DNS-only CNAME to the CloudFront domain (not proxied). |
| VPCs | Only the default VPC in each region (`172.31.0.0/16`) — no custom VPC, no NAT gateway anywhere (good — that's the one surprise cost this setup doesn't have). |
| Cost (Aug 2026, month-to-date) | EC2 Compute ~$6.72, "VPC" ~$2.91 (almost certainly the flat $0.005/hr public-IPv4 charge AWS bills under that category), EC2-Other ~$0.58 (EBS), S3 ~$0.03. Matches the ~$13/mo Sean's been seeing. |

**Conclusion:** the only thing to migrate off of is that one `t2.micro`. Nothing else in the account needs to move — but see §2's note on `data.bikemap.seanerice.dev` below.

**`data.bikemap.seanerice.dev` no longer needs to be public.** The `bikemap` bucket itself already blocks all public access (`BlockPublicAcls`/`RestrictPublicBuckets` all `true`) — the only reader is CloudFront, via an Origin Access Control. Before Epic 3, that CloudFront distribution was load-bearing: the frontend fetched `data.bikemap.seanerice.dev/export.geojson` directly. Now that the frontend fetches from the live API instead, nothing reads that public endpoint anymore. `osm-refresh.yml` still needs to *write* to the bucket (unchanged, and out of scope here — that's [Epic 4](./epics.md#epic-4--ingestion-pipeline-refactor-config-driven-bbox-based)'s territory), but the public *read* side has no consumer left. Decommissioning it is folded into Phase 3 below.

## 2. Goals / non-goals

**Goals**
- `db` (PostGIS) + `api` (ASP.NET Core) containerized and running on a single EC2 box, deployed via GitHub Actions — reusing the exact `docker-compose.yml` that already exists for local dev, not a rearchitecture.
- Static frontend (`website/dist`) on S3 + CloudFront, matching the pattern already proven by the `data.bikemap.seanerice.dev` distribution.
- **Expand → cutover → contract**, not an in-place change: new resources stood up and fully verified before any DNS changes, old resources torn down only after the cutover is confirmed stable.
- Infra provisioning as versioned, idempotent `aws-cli` shell scripts checked into the repo (`infra/`) — not Terraform/CDK/Pulumi. GitHub Actions owns the repeatable build-test-deploy pipeline; the CLI scripts own one-time/infrequent provisioning.
- The legacy `t2.micro` decommissioned once the new site is confirmed working.

**Non-goals**
- Autoscaling, multi-AZ, or any other HA beyond "one box, real backups" — this is a side project, not a service with an SLA.
- Changing how the ingestion pipeline works (`osm-refresh.yml` → S3) — that's [Epic 4](./epics.md#epic-4--ingestion-pipeline-refactor-config-driven-bbox-based), tracked separately.
- A general-purpose IaC framework.

## 3. Target architecture

```
Cloudflare (DNS + proxy)
 ├─ bikemap.seanerice.dev  ──proxied──▶ CloudFront (new dist) ──▶ S3 (frontend bucket)
 └─ api.bikemap.seanerice.dev ─proxied▶ EC2 Elastic IP ──▶ nginx (Cloudflare Origin CA cert) ──▶ api container ──▶ db container

osm-refresh.yml (unchanged) ──writes──▶ S3 (bikemap bucket) — no longer publicly readable; data.bikemap.seanerice.dev retired (§4 Phase 3)
```

### Backend: EC2 + docker-compose

- **New instance**, not the old one adapted in place: `t3a.micro` (1 vCPU/1GB RAM, AMD/x86_64, ~$6.86/mo). Amazon Linux 2023 AMI (SSM agent preinstalled, x86_64 variant).
  - **Originally planned as `t4g.micro` (ARM/Graviton, ~$6.13/mo)** — cheaper, and the plan was for Sean to take on the arm64 image-build work to get there. **Changed during story 8.7**, after actually running the real first deploy surfaced a hard blocker: `postgis/postgis` (the `db` service's image since Epic 1) publishes no arm64 build at all, across any of its ~160 tags — confirmed via Docker Hub's API, not just the one tag in use. Local dev and CI never caught this because both run on x86 machines; it only breaks on real arm64 hardware. `t3a` (AMD) over `t3` (Intel) for the same "cheapest available" reasoning that picked `t4g` originally — real current pricing confirmed via the AWS Price List API: `t3a.micro` $0.0094/hr (~$6.86/mo) vs. `t3.micro` ~$0.0104/hr (~$7.59/mo). A real estimated cost increase of ~$0.73/mo over the original arm64 plan, and it also means `api`'s image build in `deploy.yml` no longer needs the QEMU cross-build step (GitHub's runners are already x86) — one less moving part, and faster.
  - Resizing later (`t3a.micro` → `t3a.small`/`medium`, or even to `t3`/Intel) is a simple stop → `modify-instance-attribute` → start, a few minutes of downtime, no data loss — the Elastic IP and EBS root volume both persist across it, and all `t3`-family variants share the x86_64 architecture so there's no image-rebuild step this time (unlike the arm64 plan this replaced, which would have made an eventual move back to x86 a real migration). Watch memory during Phase 1 verification (§4) for signs 1GB is too tight (OOM kills, container restarts under `docker compose ps`) and size up if so.
  - If a Savings Plan gets purchased later once sizing is confirmed (§5), use a **Compute Savings Plan**, not an **EC2 Instance Savings Plan** — the former follows the workload across instance sizes/families, so a later resize doesn't strand the commitment.
  - Leave CPU credit mode on **Standard** (the default for `t3a`), not "Unlimited" — Unlimited can bill extra for sustained bursts above baseline; Standard is free and plenty for this traffic level.
- **No SSH.** Security group opens only 80/443 to `0.0.0.0/0`. Access for both humans and CI is via **AWS Systems Manager Session Manager** — no key pair to leak, no stale IP allowlist like the current box has.
- An IAM instance role grants: `AmazonSSMManagedInstanceCore`, `ssm:GetParameter` (for the two secrets below), and scoped S3 write access to a `db-backups/` prefix in the existing `bikemap` bucket.
- Docker + the Compose plugin installed via EC2 user-data at launch (cloud-init), so the box is reproducible from the launch script rather than hand-configured.
- An Elastic IP, so `api.bikemap.seanerice.dev` doesn't need to change if the instance ever stops/starts (unlike the current box).
- A new `docker-compose.prod.yml` override on top of the existing `docker-compose.yml`:
  - Drops the `5432:5432` and `5000:8080` host port publishes (dev-only conveniences today) — only nginx's 80/443 are exposed.
  - Adds an `nginx` service: reverse-proxies `api.bikemap.seanerice.dev` → `api:8080`, TLS via a **Cloudflare Origin CA certificate** rather than Let's Encrypt/Caddy. Since Cloudflare already terminates edge TLS for the domain (it's already proxying `bikemap.seanerice.dev` today), an Origin CA cert (issued once, valid up to 15 years, no renewal automation needed) with Cloudflare set to "Full (strict)" SSL mode is simpler than running a Let's Encrypt client on the box.
  - Adds a `migrator` service — a new, small `db/Migrations/Dockerfile` (doesn't exist yet) built from the existing `db/Migrations` project with the `dotnet-ef` tool installed, entrypoint `dotnet ef database update`. Run one-shot (`docker compose run --rm migrator`) over the compose-internal network, so migrations never need Postgres exposed to the host or internet. This is the missing piece today — `dotnet ef` currently only works because `docker-compose.yml` happens to publish `5432` to `localhost` for local dev; that goes away in prod.
- **Secrets** (`POSTGRES_PASSWORD`, and a GHCR pull token if the image repo ends up private — see §6) live in **SSM Parameter Store as `SecureString`s**, fetched into a `.env` file by the instance at boot. They never appear in a GitHub Actions log.
- **Backups**: a systemd timer on the box runs `docker compose exec db pg_dump ... | gzip` nightly, uploads to `s3://bikemap/db-backups/`, with an S3 lifecycle rule expiring objects after 30 days.

### Frontend: S3 + CloudFront

- New bucket (e.g. `bikemap-frontend`) + new CloudFront distribution, ACM cert for `bikemap.seanerice.dev` (CloudFront requires ACM certs in `us-east-1` regardless of where the bucket lives).
- Deployed via `aws s3 sync website/dist s3://bikemap-frontend/ --delete` + a CloudFront invalidation, mirroring the exact pattern `osm-refresh.yml` already uses for the data bucket.
- `API_BASE_URL` baked in at build time (webpack `DefinePlugin`, per story 3.3) as `https://api.bikemap.seanerice.dev`.

### CI/CD

- Container images (`api`) built in GitHub Actions and pushed to **GHCR**, not ECR — free, no extra AWS IAM/registry wiring, auth to it is already built into `GITHUB_TOKEN`.
- Built for **x86_64** (to match `t3a.micro`) via `docker buildx build --platform linux/amd64` — GitHub's hosted runners are already x86, so this is a native build, not a cross-build. (Originally planned as an emulated arm64 cross-build via `docker/setup-qemu-action`, to match a `t4g.micro` backend — dropped along with that plan; see §3's backend section for why.)
- GitHub Actions authenticates to AWS via **OIDC** (a new IAM role trusted by `token.actions.githubusercontent.com`, scoped to this repo) rather than long-lived access keys. The existing `osm-refresh.yml` keeps its static keys in the `bikemap-staging` environment for now — not in scope here, but worth migrating later for consistency.
- One workflow, gated on the existing test suites passing:
  1. Run `website` (Vitest + Playwright), `api`, and `scripts` tests.
  2. Build the `api` image, push `ghcr.io/.../clt-bicycle-map-api:<sha>` and `:latest`.
  3. Build the frontend (`npm run build` with prod `API_BASE_URL`).
  4. `aws s3 sync` the frontend build + CloudFront invalidation.
  5. `aws ssm send-command` on the EC2 instance: `docker compose pull`, run the `migrator` one-shot, then `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d` to restart `api` on the new image.

## 4. Migration plan: expand → cutover → contract

**Phase 1 — Expand** (new stuff stood up, live site untouched)
1. `infra/` aws-cli scripts: create the IAM instance role + SSM parameters, launch the new EC2 instance, allocate + associate the Elastic IP, create the frontend S3 bucket + CloudFront distribution + ACM cert.
2. Create the GitHub OIDC IAM role (one-time, via aws-cli).
3. Add `docker-compose.prod.yml`, the `nginx` service config, and `db/Migrations/Dockerfile`.
4. Deploy `db` + `api` + `migrator` to the new box; issue the Cloudflare Origin CA cert and configure nginx.
5. Verify end-to-end **before touching DNS**: hit the new Elastic IP directly with a `Host:` header override for the API, and the raw `*.cloudfront.net` URL for the frontend. Confirm `/health`, a real `/features?bbox=...` query, and the frontend rendering against it (pointed at the new IP via a local hosts-file override or a temporary build).

**Phase 2 — Cutover**
6. Cloudflare DNS: point `bikemap.seanerice.dev` at the new CloudFront distribution (proxied, matching how `data.` already works structurally, just proxied instead of DNS-only since that's how the bare domain behaves today). Add `api.bikemap.seanerice.dev` → new Elastic IP (proxied, SSL mode Full-strict).
7. Watch for a soak period (a few days) — confirm real traffic works, logs are clean, no CORS/cert surprises.

**Phase 3 — Contract**
8. Terminate `i-08cd4f6c4a4106a78`, delete `sg-087091be2c5f96f83` and the `bikemap-site-key` key pair (after confirming nothing else references them).
9. Delete the `data.bikemap.seanerice.dev` CloudFront distribution (`E27BZDOG02ZLBY`) and its Cloudflare DNS record — no consumer left post-Epic-3 (§1). Leave the `bikemap` S3 bucket and `osm-refresh.yml`'s daily sync untouched; only the public read path goes away.

## 5. Cost estimate

Based on current (Aug 2026) us-east-1 on-demand pricing:

| Resource | Est. cost/mo | Basis |
|---|---|---|
| EC2 `t3a.micro` | $6.86 | $0.0094/hr × 730hr — confirmed via the AWS Price List API. Originally planned as `t4g.micro` ($6.13/mo); switched during story 8.7 after `postgis/postgis` turned out to have no arm64 build at all — see §3's backend section. |
| EBS gp3, ~20GB | $1.60 | $0.08/GB-mo |
| Elastic IP (attached, running) | $3.65 | $0.005/hr flat public-IPv4 charge — the same line item already billing as "VPC" against the current box, just now attached to a stable address instead of a non-guaranteed auto-assigned one |
| S3 frontend bucket | ~$0.05 | A few MB of built JS/CSS |
| CloudFront (new frontend dist) | ~$0–2 | Usage-based; the existing `data.` distribution bills $0/mo at current traffic, so similarly low expected unless real visitor volume shows up |
| Nightly `pg_dump` backups in S3 (30-day retention) | ~$0.03 | Small gzip'd dump × 30 days |
| SSM Parameter Store, ACM cert, GHCR, IAM/OIDC | $0 | Free at this scale |
| **New backend + frontend total** | **~$12.2–14.2/mo** | |

Phase 3 retires the old box's spend — this month's actuals (§1) scaled to a full month: EC2 Compute ~$7.75 + EBS ~$0.67 + public IP ~$3.35 ≈ **~$11.77/mo** goes away.

**Net effect: roughly break-even, maybe up to ~+$2.5/mo** (current ~$11-13/mo → ~$12.2-14.2/mo). The `t3a.micro`→arm64-`t4g.micro` swap (§3) added a real but small ~$0.73/mo versus the original plan; the box choice still absorbs most of what the new CloudFront distribution and stable Elastic IP would otherwise have added. If Phase 1 verification shows 1GB is too tight and a resize to `t3a.small` is needed, that adds back roughly the `t3a.micro`→`t3a.small` delta (~$6.86/mo, confirmed via the same Price List API query).

## 6. Open follow-ups

- ~~**GHCR image visibility**~~ — **resolved: the repo is public**, so the `api` GHCR package can be public too. No pull token needed on the EC2 box.
- **`osm-refresh.yml`'s long-lived AWS keys** — not migrated to OIDC as part of this plan, but the new OIDC role setup makes it a small follow-up later.
- **Backup restore drill** — the plan adds backups but doesn't yet include actually testing a restore. Worth doing once, after Phase 2, so "we have backups" isn't untested.
- **Monitoring/alerting** — out of scope here (ties into [Epic 6](./epics.md#epic-6--observability-data-quality--abuse-protection-cross-cutting)); the health check endpoint exists but nothing currently polls it in prod.
