"""
Integration tests for the PostGIS persistence layer's schema/constraints
(db/Migrations, docs/planning/layers/persistence-layer.md §1.1/§5/§8).

Runs against a live docker-compose `db` service, applying migrations from
empty and loading a small hand-written fixture set (NOT the full
data/export.geojson) spanning all three feature_type values. See
conftest.py for how the db is brought up/migrated and how per-test
isolation works.

Single documented command to run the whole suite (from repo root, with
POSTGRES_PASSWORD set — see .env.example, same convention as
scripts/load_export_to_postgis.py and db/Migrations):

    POSTGRES_PASSWORD=<value> pytest scripts/tests/test_persistence_integration.py

Requires: `docker compose up -d db` reachable (this suite brings it up
itself if it isn't already), and the .NET SDK + dotnet-ef tool available on
PATH (used by conftest.py's session fixture to apply migrations).
"""

import time

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from load_export_to_postgis import INSERT_SQL


def load_fixtures(conn, fixtures):
    with conn.cursor() as cur:
        cur.executemany(INSERT_SQL, fixtures)


def fetch_all(conn):
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute("SELECT * FROM features ORDER BY osm_type, osm_id;")
        return cur.fetchall()


# --- Fixture features -------------------------------------------------
#
# A small, hand-written set spanning all three feature_type values
# (road/path/route), matching the param shape load_export_to_postgis.py's
# feature_to_params() produces (i.e. what INSERT_SQL expects), not raw
# GeoJSON features. Geometries are simple two-point LineStrings placed so
# that ROAD_A and PATH_A fall entirely inside TEST_ENVELOPE below, while
# ROUTE_A sits far outside it — used by the bbox-query tests.

ROAD_A = {
    "osm_type": "way",
    "osm_id": 1001,
    "feature_type": "road",
    "geometry_json": '{"type":"LineString","coordinates":[[1,1],[2,2]]}',
    "cycleway_left": "lane",
    "cycleway_right": "lane",
    "cycleway_left_buffer": False,
    "cycleway_right_buffer": False,
    "bicycle": None,
    "route": None,
    "cycle_network": None,
    "ref": None,
    "name": "Test Road A",
    "state": None,
    "tags": Jsonb({"highway": "residential"}),
}

PATH_A = {
    "osm_type": "way",
    "osm_id": 1002,
    "feature_type": "path",
    "geometry_json": '{"type":"LineString","coordinates":[[3,3],[4,4]]}',
    "cycleway_left": None,
    "cycleway_right": None,
    "cycleway_left_buffer": False,
    "cycleway_right_buffer": False,
    "bicycle": "designated",
    "route": None,
    "cycle_network": None,
    "ref": None,
    "name": "Test Path A",
    "state": None,
    "tags": Jsonb({"highway": "cycleway"}),
}

ROUTE_A = {
    "osm_type": "relation",
    "osm_id": 2001,
    "feature_type": "route",
    "geometry_json": '{"type":"LineString","coordinates":[[50,50],[51,51]]}',
    "cycleway_left": None,
    "cycleway_right": None,
    "cycleway_left_buffer": False,
    "cycleway_right_buffer": False,
    "bicycle": None,
    "route": "bicycle",
    "cycle_network": "ncn",
    "ref": "1",
    "name": "Test Route A",
    "state": None,
    "tags": Jsonb({"route": "bicycle", "network": "ncn"}),
}

FIXTURES = [ROAD_A, PATH_A, ROUTE_A]

# min_lon, min_lat, max_lon, max_lat — contains ROAD_A and PATH_A entirely,
# clearly excludes ROUTE_A.
TEST_ENVELOPE = (0, 0, 10, 10)

BBOX_SQL = """
SELECT osm_type, osm_id FROM features
WHERE geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
  AND ST_Intersects(geom, ST_MakeEnvelope(%s, %s, %s, %s, 4326));
"""


class TestIdempotentUpsert:
    def test_repeated_load_is_idempotent(self, db_conn):
        load_fixtures(db_conn, FIXTURES)
        first = {(r["osm_type"], r["osm_id"]): r for r in fetch_all(db_conn)}
        assert len(first) == len(FIXTURES)

        # Small delay so last_seen_at is unambiguously later on the second
        # load rather than relying on the two loads landing in different
        # postgres clock ticks by chance.
        time.sleep(0.05)

        load_fixtures(db_conn, FIXTURES)
        second = {(r["osm_type"], r["osm_id"]): r for r in fetch_all(db_conn)}

        assert len(second) == len(FIXTURES), "re-loading must not create new rows"
        for key, row in second.items():
            assert row["first_seen_at"] == first[key]["first_seen_at"], (
                f"first_seen_at changed on re-upsert for {key}"
            )
            assert row["last_seen_at"] > first[key]["last_seen_at"], (
                f"last_seen_at did not advance on re-upsert for {key}"
            )


class TestBboxQuery:
    def test_bbox_includes_features_inside_envelope(self, db_conn):
        load_fixtures(db_conn, FIXTURES)
        with db_conn.cursor() as cur:
            cur.execute(BBOX_SQL, TEST_ENVELOPE * 2)
            results = {(row[0], row[1]) for row in cur.fetchall()}

        assert ("way", 1001) in results  # ROAD_A, inside the envelope
        assert ("way", 1002) in results  # PATH_A, inside the envelope

    def test_bbox_excludes_features_outside_envelope(self, db_conn):
        load_fixtures(db_conn, FIXTURES)
        with db_conn.cursor() as cur:
            cur.execute(BBOX_SQL, TEST_ENVELOPE * 2)
            results = {(row[0], row[1]) for row in cur.fetchall()}

        assert ("relation", 2001) not in results  # ROUTE_A, clearly outside
        assert results == {("way", 1001), ("way", 1002)}


class TestConstraintRejection:
    """
    Both cases assert on the specific constraint name via psycopg's error
    diagnostics (exc.diag.constraint_name), not just "an exception was
    raised" — so a test can't pass for the wrong reason (e.g. a typo in the
    SQL producing some unrelated error).

    The invalid-geometry case uses a degenerate two-point LineString with
    coincident points (`LINESTRING(0 0, 0 0)`), confirmed interactively
    against this schema to fail ST_IsValid with "Too few points in geometry
    component". A self-intersecting LineString was deliberately NOT used —
    also confirmed interactively — because self-intersection is an OGC
    *simplicity* rule for polygons, not a *validity* rule PostGIS enforces
    on LineStrings; ST_IsValid('LINESTRING(0 0, 2 2, 2 0, 0 2)') returns
    true, so it would not trip chk_features_geom_valid at all.
    """

    def test_invalid_geometry_rejected(self, db_conn):
        with pytest.raises(psycopg.errors.CheckViolation) as exc_info:
            with db_conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO features (osm_type, osm_id, feature_type, geom)
                    VALUES (%s, %s, %s, ST_GeomFromText(%s, 4326))
                    """,
                    ("way", 9001, "road", "LINESTRING(0 0, 0 0)"),
                )

        assert exc_info.value.diag.constraint_name == "chk_features_geom_valid"

    def test_duplicate_osm_key_rejected_without_on_conflict(self, db_conn):
        with db_conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO features (osm_type, osm_id, feature_type, geom)
                VALUES (%s, %s, %s, ST_GeomFromText(%s, 4326))
                """,
                ("way", 9002, "road", "LINESTRING(0 0, 1 1)"),
            )

        with pytest.raises(psycopg.errors.UniqueViolation) as exc_info:
            with db_conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO features (osm_type, osm_id, feature_type, geom)
                    VALUES (%s, %s, %s, ST_GeomFromText(%s, 4326))
                    """,
                    ("way", 9002, "road", "LINESTRING(2 2, 3 3)"),
                )

        assert exc_info.value.diag.constraint_name == "ux_features_osm_key"
