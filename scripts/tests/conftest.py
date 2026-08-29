"""
Shared pytest fixtures for the persistence-layer integration tests (Story
1.8, docs/planning/layers/persistence-layer.md §8).

These tests run against a live PostGIS `db` docker-compose service with
migrations applied. See test_persistence_integration.py's module docstring
for the single documented command to run the suite, and CLAUDE.md's
Database section for the general `db` setup.

Fixture strategy (session vs. per-test):

- `_db_ready` (session-scoped, autouse): runs once per test session. Brings
  up `docker compose up -d db` — a no-op if it's already running, since
  compose just reconciles to the same desired state — waits for Postgres to
  accept connections, then applies EF Core migrations via
  `dotnet ef database update` from db/Migrations/ (also idempotent: it only
  applies pending migrations). This means a completely fresh
  `docker compose down -v` environment works with a single `pytest`
  invocation, with no separate manual migration step required first.

- `db_conn` (function-scoped): opens a fresh psycopg connection per test,
  in autocommit mode, and truncates `features` (RESTART IDENTITY) before
  yielding, so every test starts from an empty table regardless of what
  earlier tests inserted — that's the "leaves the table clean between
  tests" isolation story, chosen over wrapping each test in one outer
  transaction that rolls back. Autocommit is deliberate: the
  constraint-rejection tests (TestConstraintRejection) need a real
  failed-statement boundary to inspect psycopg's raised exception
  diagnostics against. With autocommit, a failing statement only aborts
  itself — not any earlier statement the same test already ran — so tests
  don't need their own rollback bookkeeping around expected failures.
"""

import os
import subprocess
import sys
import time
from pathlib import Path

import psycopg
import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = REPO_ROOT / "db" / "Migrations"
SCRIPTS_DIR = REPO_ROOT / "scripts"

# Put scripts/ on sys.path so the tests can import the `pipeline` package
# (`from pipeline.ingest import INSERT_SQL`, `from pipeline import config`, etc.)
# without installing it.
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

def pytest_configure(config):
    # Registers the `slow` marker used by test_explain_index_usage.py
    # (Story 1.9) so pytest doesn't warn about an unknown marker, and so
    # `-m "not slow"` / `-m slow` deselection works. No pytest.ini/pyproject
    # section exists in this repo yet, so this hook is the marker's home.
    config.addinivalue_line(
        "markers", "slow: marks tests as slow/optional (deselect with -m \"not slow\")"
    )


POSTGRES_PASSWORD = os.environ.get("POSTGRES_PASSWORD")
if not POSTGRES_PASSWORD:
    pytest.exit(
        "POSTGRES_PASSWORD is not set. These integration tests need it to "
        "reach the docker-compose `db` service and to run "
        "`dotnet ef database update` — set it the same way docker-compose "
        "and db/Migrations/ do (see ../../.env.example), e.g.:\n"
        "  POSTGRES_PASSWORD=... pytest scripts/tests/test_persistence_integration.py",
        returncode=1,
    )

CONNECTION_KWARGS = {
    "host": os.environ.get("POSTGRES_HOST", "localhost"),
    "port": int(os.environ.get("POSTGRES_PORT", "5432")),
    "dbname": os.environ.get("POSTGRES_DB", "bikemap"),
    "user": os.environ.get("POSTGRES_USER", "bikemap"),
    "password": POSTGRES_PASSWORD,
}


def _wait_for_db(timeout_seconds=60):
    deadline = time.monotonic() + timeout_seconds
    last_error = None
    while time.monotonic() < deadline:
        try:
            with psycopg.connect(**CONNECTION_KWARGS, connect_timeout=3):
                return
        except psycopg.OperationalError as exc:
            last_error = exc
            time.sleep(1)
    raise RuntimeError(
        f"db service never became reachable within {timeout_seconds}s: {last_error}"
    )


@pytest.fixture(scope="session", autouse=True)
def _db_ready():
    try:
        subprocess.run(
            ["docker", "compose", "up", "-d", "db"],
            cwd=REPO_ROOT,
            check=True,
        )
    except FileNotFoundError:
        pytest.exit(
            "docker is not installed or not on PATH. These integration "
            "tests need it to bring up the docker-compose `db` service — "
            "install Docker Desktop (or the docker CLI) and make sure it's "
            "on PATH, then re-run:\n"
            "  POSTGRES_PASSWORD=... pytest scripts/tests/test_persistence_integration.py",
            returncode=1,
        )
    _wait_for_db()

    env = dict(os.environ)
    env["POSTGRES_PASSWORD"] = POSTGRES_PASSWORD
    try:
        subprocess.run(
            ["dotnet", "ef", "database", "update"],
            cwd=MIGRATIONS_DIR,
            env=env,
            check=True,
        )
    except FileNotFoundError:
        pytest.exit(
            "dotnet ef is not installed or not on PATH. These integration "
            "tests need it to apply EF Core migrations from db/Migrations/ "
            "— install it with `dotnet tool install --global dotnet-ef` and "
            "make sure it's on PATH, then re-run:\n"
            "  POSTGRES_PASSWORD=... pytest scripts/tests/test_persistence_integration.py",
            returncode=1,
        )


@pytest.fixture
def db_conn():
    with psycopg.connect(**CONNECTION_KWARGS, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute("TRUNCATE TABLE features RESTART IDENTITY;")
        yield conn
