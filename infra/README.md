# infra/

Idempotent `aws-cli` shell scripts that provision the AWS resources
described in [`docs/planning/deployment.md`](../docs/planning/deployment.md)
§3 ("Target architecture") — a `t4g.micro` EC2 box running `db`+`api` via
docker-compose, and an S3+CloudFront static frontend. Plain `aws-cli`
shell, not Terraform/CDK/Pulumi, per deployment.md §2.

> **These scripts are not run as part of stories 8.1/8.2.** They are
> written and statically verified only (`bash -n`, `shellcheck` where
> available, and code review — see each story's acceptance criteria in
> `docs/planning/stories.md`). None of them touch the real AWS account
> or create/modify/delete any real resource as part of writing them.
> Actually running them against the real account is stories 8.5
> (backend) and 8.6 (frontend) — explicitly manual-execution-only, not
> run via the autonomous `/execute-epic` flow (see the Epic 8 warning in
> `docs/planning/stories.md`).

## Shared setup

Every script sources [`lib.sh`](./lib.sh) (via `SCRIPT_DIR`-relative
path, so it doesn't matter what directory you run from) for shared
constants — region, resource names, project tag — and two small helpers
(`require_aws_cli`, `account_id`). `lib.sh` isn't run directly.

All scripts default `AWS_REGION` to `us-east-1` (matching the existing
legacy EC2 box's region — see deployment.md §1), overridable via the
environment: `AWS_REGION=us-west-2 ./01-iam-role.sh`. The one exception
is the ACM certificate (`frontend/02-acm-certificate.sh`), which always
targets `us-east-1` regardless of `$AWS_REGION` — CloudFront requires
ACM certs to be issued there, full stop.

Every resource created is tagged `Project=bikemap`, and every script
looks its inputs/outputs up by name or tag (describe-then-create) rather
than taking resource IDs as arguments — that's what makes re-running a
script after it already succeeded a no-op instead of a duplicate or an
error.

## `infra/backend/` — story 8.1

Run in this order:

1. **`01-iam-role.sh`** — IAM role + instance profile for the EC2
   instance. Grants exactly: the AWS-managed
   `AmazonSSMManagedInstanceCore` policy (Session Manager access — the
   only way onto the box, since there's no SSH), a scoped
   `ssm:GetParameter` on the one parameter `03-ssm-parameter.sh`
   creates, and a scoped `s3:PutObject` on
   `s3://bikemap/db-backups/*` only (nightly `pg_dump` backups).
   Nothing broader.
2. **`02-security-group.sh`** — security group opening **only** 80 and
   443 inbound from `0.0.0.0/0`. No port 22, ever — access is via SSM
   Session Manager (role from step 1), not SSH; no key pair is created
   or referenced anywhere under `infra/`.
3. **`03-ssm-parameter.sh`** — SSM `SecureString` parameter for
   `POSTGRES_PASSWORD`. No GHCR pull token parameter — the `api` image's
   GHCR repo is public (deployment.md §6), so nothing is needed to pull
   it.
4. **`04-launch-instance.sh`** — launches the `t4g.micro` instance
   (Amazon Linux 2023, arm64), attached to steps 1–2's role and security
   group, with [`user-data.sh`](./backend/user-data.sh) installing
   Docker + the Compose plugin at boot (nothing app-specific — deploying
   the app itself is story 8.3/8.4/8.7's job). Passes
   `--credit-specification CpuCredits=standard` explicitly. Supports
   `DRY_RUN=1 ./04-launch-instance.sh` to pass `--dry-run` through to
   `run-instances` — a real AWS CLI dry-run that validates IAM
   permissions and request parameters without creating anything; the
   safe way to sanity-check credentials ahead of story 8.5 actually
   running this for real.
5. **`05-elastic-ip.sh`** — allocates an Elastic IP and associates it
   with the instance from step 4, so `api.bikemap.seanerice.dev` stays
   stable across stop/start.

## `infra/frontend/` — story 8.2

Independent of `infra/backend/` — can run before, after, or interleaved
with it. Run in this order:

1. **`01-s3-bucket.sh`** — creates the new `bikemap-frontend` bucket
   (separate from the existing `bikemap` data-pipeline bucket) and sets
   all four public-access-block flags (`BlockPublicAcls`,
   `BlockPublicPolicy`, `IgnorePublicAcls`, `RestrictPublicBuckets`) to
   `true` — matching the existing bucket's posture.
2. **`02-acm-certificate.sh`** — requests the ACM certificate for
   `bikemap.seanerice.dev`, DNS-validated, **in `us-east-1`
   specifically** (see the comment at the top of the script for why).
   Prints the `describe-certificate` command needed to fetch the
   validation CNAME to add in Cloudflare by hand (not scriptable via
   aws-cli) — that step happens in story 8.5/8.6, not here.
3. **`03-cloudfront-distribution.sh`** — creates an Origin Access
   Control (OAC — not a legacy Origin Access Identity, not a public
   bucket policy) and a CloudFront distribution using it as the sole way
   to read the bucket from step 1, with the ACM cert from step 2
   attached for the `bikemap.seanerice.dev` alias. Applies a bucket
   policy scoped to that one distribution's ARN so CloudFront's signed
   requests can read the bucket, while the bucket's public-access-block
   settings from step 1 stay fully enabled.

## Verifying without touching AWS

```
bash -n infra/backend/*.sh infra/frontend/*.sh infra/lib.sh
shellcheck infra/backend/*.sh infra/frontend/*.sh infra/lib.sh   # if installed
```

Beyond syntax checking, "verification" for 8.1/8.2 is code review against
each story's acceptance criteria in `docs/planning/stories.md` — no
script here is executed against the real AWS account as part of writing
or reviewing it.
