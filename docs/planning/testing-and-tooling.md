# Testing, containerization & AI-assisted tooling

Status: Draft for review
Owner: Sean Rice
Last updated: 2026-07-27

Companion to [multi-city-expansion.md](./multi-city-expansion.md) — that doc covers the data/serving architecture; this one covers how we build confidence that it (and the UI) actually works, how it's packaged to run anywhere, and what of that we lean on Claude Code for. Split into app-specific concerns and AI-tooling concerns per Sean's request, since they're genuinely different audiences (a future contributor vs. a future Claude Code session).

## 1. Containerization (goal)

Everything on the backend — PostGIS, the bbox API (see multi-city-expansion.md §4.2), and the ingestion pipeline — should run via Docker / docker-compose. Two reasons this earns "goal" status rather than being an implementation detail:
- **Local dev parity**: `docker compose up` gets a contributor (or an agent) a working stack without hand-installing Postgres/PostGIS locally.
- **It's also the deploy unit** — whatever we land on for hosting (§3), "a docker-compose stack on a box" is the phase-1 target either way, so containerizing now isn't throwaway work.

Bonus: the same compose stack is what integration tests (§2) spin up in CI — one definition, two uses.

## 2. Testing strategy

Categories worth having, not a specific test list — that gets figured out at implementation time.

### Backend / pipeline
- **Unit tests** — pure transform/business logic, no I/O (the OSM-tag transform functions, any query-building logic). Fast, run on every commit, highest value-per-effort since this logic is currently untested entirely.
- **Integration tests** — anything touching real infra: DB upserts + spatial queries, bbox API responses for a given viewport. Run against the containerized stack from §1, both locally and in CI.
- **Data-quality checks** — a different category from code correctness: sanity-check the *output* of each ingestion run (a city's feature count didn't collapse to zero, geometries are valid, no duplicate OSM ids). This matters more once ingestion is automated across many cities and nobody's eyeballing the output file the way one might today.
- **Contract tests** — guard the specific properties the frontend depends on (`cyclewayLeft`, `bicycle`, `highwayType`, etc.) so a backend or schema change can't silently break rendering without a test catching it first.

### Frontend / UI
- **Component/unit tests** — lower priority; most of the app is declarative rendering + Mapbox wiring rather than standalone logic. Worth adding only where real logic lives client-side.
- **E2E (Playwright)** — the real backbone for this app: load the map, verify layers render, toggle layer visibility, exercise search/directions, assert no console errors. Deterministic and cheap enough to run on every PR.
- **Agent-driven walkthroughs** — qualitative, not run on every commit; see §4.

## 3. Deployment (deferred)

Sean wants to pick this back up separately — parking it here rather than in the main doc so it doesn't get lost. One correction worth carrying forward into that conversation: S3 isn't storage *for* a database — it's object storage for files/blobs, a good fit for the frontend build output or OSM data snapshots/backups, but not something PostGIS reads or writes to directly. A database needs real block storage (a managed option like RDS, or a volume attached to whatever box runs the container). The containerization goal in §1 means this decision is mostly "where does the compose stack run," not an architecture change.

## 4. AI-assisted development tooling

Distinct from the app's own test suite above — this is about how Claude Code itself gets configured to work on this repo well.

- **Agent-driven walkthroughs** — for larger features (not every commit), have an agent actually launch the running app and click through it — pan/zoom, toggle layers, run a search — and judge whether it looks and behaves right, the way a human would eyeball a preview deploy. This is what the built-in `run` skill is for. Once the app is containerized (§1), add a project-level skill (e.g. `.claude/skills/run.md`) that tells it how to launch *this* app specifically (`docker compose up`, wait-for-healthy, open the frontend) — `run`'s built-in fallback looks for exactly that before guessing at generic patterns.
- **Playwright** — agreed as the deterministic E2E layer (§2), and a reasonable, modern default. Once it exists, its run command belongs in `CLAUDE.md` so future sessions (and CI) don't have to rediscover it.
- **Autonomous fixing** — discussed and intentionally set aside for now, not a near-term goal.
- **Standing principle**: as each of these lands (docker-compose, Playwright, a project skill), treat updating `CLAUDE.md` / adding the skill as part of "done" for that piece of work, rather than a separate documentation project. That's the doc-automation Sean asked about in the original scope — it's just distributed across the work instead of centralized.
