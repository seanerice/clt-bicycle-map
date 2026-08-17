"""
Story 1.9 (docs/planning/layers/persistence-layer.md §8, "optionally"):
EXPLAIN(ANALYZE) regression test proving `idx_features_geom` (the GiST
spatial index on `features.geom`) is actually used for a bbox query,
rather than the query falling back to a full sequential scan of `features`.

This is cheap insurance against a future migration accidentally
dropping/invalidating the spatial index without anything else noticing —
none of the other integration tests in this directory would catch that,
since they only assert on query *results*, not on the query *plan*.

Why a realistically-sized fixture set is required (not just a handful of
rows, per the other tests in this directory): Postgres's planner chooses
between a sequential scan and an index scan by cost, not by rule, and a
seq scan can legitimately be cheaper on a tiny table regardless of index
availability. A test asserting "index scan happened" against a 3-row table
would not actually be exercising the planner's real preference — it could
pass today and still fail to catch a dropped index once the real
`features` table has millions of rows. So this test loads hundreds to
low-thousands of synthetic rows, scattered across a realistically large
lon/lat extent, and queries a bbox covering only a small, selective subset
of that extent — see FIXTURE_COUNT / EXTENT / QUERY_ENVELOPE below for the
actual numbers, verified interactively (see this story's report) to
reliably produce an Index Scan on idx_features_geom rather than a Seq Scan
on features.

Marked `@pytest.mark.slow` (see conftest.py's pytest_configure hook for
the marker registration) since generating/loading thousands of rows makes
this noticeably slower than the rest of the suite. Excluded from the fast
default run; see CLAUDE.md's testing section for the exact commands:

    # fast path (excludes this test)
    POSTGRES_PASSWORD=<value> pytest scripts/tests -m "not slow"

    # full path (includes this test)
    POSTGRES_PASSWORD=<value> pytest scripts/tests
"""

import json
import random

import pytest
from psycopg.types.json import Jsonb

from load_export_to_postgis import INSERT_SQL

# Synthetic data is scattered across a 20deg x 20deg lon/lat box (roughly
# the size of the eastern half of the continental US) — large relative to
# the query bbox below, so the query is genuinely selective rather than
# matching most of the table.
EXTENT_MIN_LON, EXTENT_MAX_LON = -90.0, -70.0
EXTENT_MIN_LAT, EXTENT_MAX_LAT = 25.0, 45.0

# A 2deg x 2deg subset of the extent above (~1% of its area) — deliberately
# NOT the whole extent, so the query only matches a small slice of the
# fixture rows. min_lon, min_lat, max_lon, max_lat.
QUERY_ENVELOPE = (-81.0, 34.0, -79.0, 36.0)

# Verified interactively (see this story's report) to produce an Index
# Scan on idx_features_geom at this size, with the query above matching a
# small subset (tens of rows) of the total — not zero, not the whole
# table. Smaller sizes (tested down to 5 rows) also produced an index
# scan for this particular query shape (ST_Intersects is planner-costed as
# expensive per row, which pushes the planner toward the index even on
# small tables), but the story calls for a realistically-sized fixture set
# regardless, so this uses a "low thousands" count rather than relying on
# that.
FIXTURE_COUNT = 2000

FEATURE_TYPES = ["road", "path", "route"]


def _synthetic_fixture(i, rng):
    lon = rng.uniform(EXTENT_MIN_LON, EXTENT_MAX_LON)
    lat = rng.uniform(EXTENT_MIN_LAT, EXTENT_MAX_LAT)
    # Second point offset slightly so the LineString has two distinct
    # points (a degenerate LINESTRING(p, p) fails chk_features_geom_valid).
    lon2 = lon + rng.uniform(0.001, 0.05)
    lat2 = lat + rng.uniform(0.001, 0.05)

    feature_type = FEATURE_TYPES[i % 3]
    osm_type = "relation" if feature_type == "route" else "way"

    return {
        "osm_type": osm_type,
        "osm_id": 90_000_000 + i,
        "feature_type": feature_type,
        "geometry_json": json.dumps(
            {"type": "LineString", "coordinates": [[lon, lat], [lon2, lat2]]}
        ),
        "cycleway_left": None,
        "cycleway_right": None,
        "cycleway_left_buffer": False,
        "cycleway_right_buffer": False,
        "bicycle": None,
        "route": "bicycle" if feature_type == "route" else None,
        "cycle_network": None,
        "ref": None,
        "name": f"Synthetic feature {i}",
        "state": None,
        "tags": Jsonb({}),
    }


def _iter_plan_nodes(node):
    """Recursively yield every node in an EXPLAIN (FORMAT JSON) plan tree."""
    yield node
    for child in node.get("Plans", []):
        yield from _iter_plan_nodes(child)


@pytest.mark.slow
class TestExplainIndexUsage:
    def test_bbox_query_uses_geom_index_not_seq_scan(self, db_conn):
        rng = random.Random(1234)  # deterministic fixture generation
        fixtures = [_synthetic_fixture(i, rng) for i in range(FIXTURE_COUNT)]

        with db_conn.cursor() as cur:
            cur.executemany(INSERT_SQL, fixtures)
            # Bulk-inserted rows have no planner statistics yet; without
            # this the planner is working off stale/absent stats (possibly
            # from a previous test's truncated-to-empty table) and could
            # pick a scan type that has nothing to do with the data
            # actually loaded here.
            cur.execute("ANALYZE features;")

            cur.execute(
                """
                EXPLAIN (ANALYZE, FORMAT JSON)
                SELECT * FROM features
                WHERE geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
                  AND ST_Intersects(geom, ST_MakeEnvelope(%s, %s, %s, %s, 4326));
                """,
                QUERY_ENVELOPE * 2,
            )
            plan_result = cur.fetchone()[0]

        root = plan_result[0]["Plan"]
        nodes = list(_iter_plan_nodes(root))

        seq_scans_on_features = [
            n
            for n in nodes
            if n.get("Node Type") == "Seq Scan" and n.get("Relation Name") == "features"
        ]
        assert not seq_scans_on_features, (
            "Expected the bbox query to use idx_features_geom, but found a "
            f"Seq Scan on features instead. Full plan:\n{json.dumps(plan_result, indent=2)}"
        )

        geom_index_scans = [
            n
            for n in nodes
            if n.get("Node Type") in ("Index Scan", "Bitmap Index Scan")
            and n.get("Index Name") == "idx_features_geom"
        ]
        assert geom_index_scans, (
            "Expected an Index Scan or Bitmap Index Scan on idx_features_geom "
            f"somewhere in the plan, found none. Full plan:\n{json.dumps(plan_result, indent=2)}"
        )

        # Sanity check on the fixture/bbox design itself, not just the plan:
        # the query must be genuinely selective (matches some rows, but not
        # the whole table) for "the planner preferred the index" to mean
        # anything. If this ever fails, QUERY_ENVELOPE/FIXTURE_COUNT above
        # need adjusting.
        matched_rows = root["Actual Rows"]
        assert 0 < matched_rows < FIXTURE_COUNT, (
            f"Expected the query to match a selective subset of the "
            f"{FIXTURE_COUNT} fixture rows, matched {matched_rows} instead — "
            "adjust QUERY_ENVELOPE/FIXTURE_COUNT so the test bbox is "
            "meaningfully selective."
        )
