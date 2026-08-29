"""Integration test for scripts/pipeline/ingest.py against the live `db` service.

Uses the same conftest.py machinery as test_persistence_integration.py (the
session `_db_ready` fixture brings up docker + migrations; `db_conn` truncates
`features` per test). `ingest.upsert()` opens its own psycopg connection from the
POSTGRES_* env, so `db_conn` here is only used to read results back.
"""

import time

import pytest
from psycopg.rows import dict_row

from pipeline import ingest


def _road_feature(osm_id):
    return {
        "type": "Feature",
        "properties": {
            "type": "route",  # deliberately the clobbered value -- ingest must ignore it
            "osmType": "way",
            "featureType": "road",
            "id": osm_id,
            "tags": {"highway": "residential", "cycleway": "lane"},
            "cyclewayLeft": "lane",
            "cyclewayRight": "lane",
        },
        "geometry": {"type": "LineString", "coordinates": [[-80.90, 35.20], [-80.80, 35.30]]},
    }


def _route_feature(osm_id):
    return {
        "type": "Feature",
        "properties": {
            "type": "route",
            "osmType": "relation",
            "featureType": "route",
            "id": osm_id,
            "route": "bicycle",
            "cycle_network": "lcn",
            "name": "Test Greenway",
            "tags": {"type": "route", "route": "bicycle", "network": "lcn"},
        },
        "geometry": {"type": "LineString", "coordinates": [[-80.85, 35.22], [-80.84, 35.25]]},
    }


def _rows(conn):
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute("SELECT * FROM features ORDER BY osm_type, osm_id;")
        return {(r["osm_type"], r["osm_id"]): r for r in cur.fetchall()}


class TestIngestUpsert:
    def test_inserts_rows_with_correct_type_mapping(self, db_conn):
        n = ingest.upsert([_road_feature(1001), _route_feature(2001)])
        assert n == 2

        rows = _rows(db_conn)
        assert set(rows) == {("way", 1001), ("relation", 2001)}
        assert rows[("way", 1001)]["feature_type"] == "road"
        assert rows[("relation", 2001)]["feature_type"] == "route"
        assert rows[("way", 1001)]["cycleway_left"] == "lane"
        assert rows[("relation", 2001)]["cycle_network"] == "lcn"

    def test_reingest_is_idempotent(self, db_conn):
        feats = [_road_feature(1001), _route_feature(2001)]
        ingest.upsert(feats)
        first = _rows(db_conn)
        assert len(first) == 2

        time.sleep(0.05)
        ingest.upsert(feats)
        second = _rows(db_conn)

        assert len(second) == 2, "re-ingest must not create new rows"
        for key, row in second.items():
            assert row["first_seen_at"] == first[key]["first_seen_at"], (
                f"first_seen_at moved for {key}"
            )
            assert row["last_seen_at"] > first[key]["last_seen_at"], (
                f"last_seen_at did not advance for {key}"
            )

    def test_empty_feature_list_is_a_noop(self, db_conn):
        assert ingest.upsert([]) == 0
        assert _rows(db_conn) == {}
