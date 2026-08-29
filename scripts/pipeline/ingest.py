"""Batch UPSERT of transformed features into the PostGIS ``features`` table.

Replaces the old ``fetch_data.py`` ``write_data()`` (which dumped a minified
GeoJSON ``FeatureCollection`` to ``data/export.geojson`` for the S3 sync).

The ``INSERT_SQL`` statement and the ``connection_kwargs()`` env convention are
carried forward byte-for-byte from the now-deleted
``scripts/load_export_to_postgis.py`` (story 1.7's throwaway validation loader).
``INSERT_SQL`` is exported so the persistence integration tests import it from
here.

**Transaction scope:** one transaction per ``upsert()`` call. ``__main__`` calls
``upsert()`` once per area, so an ``--all`` run is N transactions, one per area
(a Phase-1 stopgap does not need whole-run atomicity -- stories.md 4.2).
"""

import json
import os
import sys

import psycopg
from psycopg.types.json import Jsonb

# Exact pattern from the deleted scripts/load_export_to_postgis.py (itself from
# docs/planning/layers/persistence-layer.md §5). Do not "improve" it.
INSERT_SQL = """
INSERT INTO features (
    osm_type, osm_id, feature_type, geom,
    cycleway_left, cycleway_right, cycleway_left_buffer, cycleway_right_buffer,
    bicycle, route, cycle_network, ref, name, state, tags
) VALUES (
    %(osm_type)s, %(osm_id)s, %(feature_type)s, ST_GeomFromGeoJSON(%(geometry_json)s),
    %(cycleway_left)s, %(cycleway_right)s, %(cycleway_left_buffer)s, %(cycleway_right_buffer)s,
    %(bicycle)s, %(route)s, %(cycle_network)s, %(ref)s, %(name)s, %(state)s, %(tags)s
)
ON CONFLICT (osm_type, osm_id) DO UPDATE SET
    feature_type = EXCLUDED.feature_type,
    geom = EXCLUDED.geom,
    cycleway_left = EXCLUDED.cycleway_left,
    cycleway_right = EXCLUDED.cycleway_right,
    cycleway_left_buffer = EXCLUDED.cycleway_left_buffer,
    cycleway_right_buffer = EXCLUDED.cycleway_right_buffer,
    bicycle = EXCLUDED.bicycle,
    route = EXCLUDED.route,
    cycle_network = EXCLUDED.cycle_network,
    ref = EXCLUDED.ref,
    name = EXCLUDED.name,
    state = EXCLUDED.state,
    tags = EXCLUDED.tags,
    last_seen_at = now();
"""

BATCH_SIZE = 1000


def connection_kwargs():
    password = os.environ.get("POSTGRES_PASSWORD")
    if not password:
        sys.exit(
            "POSTGRES_PASSWORD is not set. Set it in your environment "
            "(e.g. via the repo-root .env, the same file docker-compose "
            "and db/Migrations read — see .env.example) before running "
            "the pipeline."
        )
    return {
        "host": os.environ.get("POSTGRES_HOST", "localhost"),
        "port": int(os.environ.get("POSTGRES_PORT", "5432")),
        "dbname": os.environ.get("POSTGRES_DB", "bikemap"),
        "user": os.environ.get("POSTGRES_USER", "bikemap"),
        "password": password,
    }


def feature_to_params(feature):
    """Map one transformed feature dict to the bound-parameter dict INSERT_SQL wants."""
    properties = feature["properties"]

    # osm_type / feature_type come from the explicit fields transform.py sets
    # (osmType / featureType) -- NOT properties["type"], which the OSM tag spread
    # clobbers to "route" for route relations.
    osm_type = properties["osmType"]
    feature_type = properties["featureType"]

    # cyclewayLeftBuffer / cyclewayRightBuffer are only ever present (as the
    # string "yes") when transform_road_feature's hasCyclewayBufferValue() was
    # truthy; absent otherwise. Map to the BOOLEAN NOT NULL columns.
    cycleway_left_buffer = properties.get("cyclewayLeftBuffer") == "yes"
    cycleway_right_buffer = properties.get("cyclewayRightBuffer") == "yes"

    return {
        "osm_type": osm_type,
        "osm_id": properties["id"],
        "feature_type": feature_type,
        "geometry_json": json.dumps(feature["geometry"]),
        "cycleway_left": properties.get("cyclewayLeft"),
        "cycleway_right": properties.get("cyclewayRight"),
        "cycleway_left_buffer": cycleway_left_buffer,
        "cycleway_right_buffer": cycleway_right_buffer,
        "bicycle": properties.get("bicycle"),
        "route": properties.get("route"),
        "cycle_network": properties.get("cycle_network"),
        "ref": properties.get("ref"),
        "name": properties.get("name"),
        "state": properties.get("state"),
        # Full raw OSM tag bag, unfiltered (persistence-layer.md §1.2 hybrid:
        # dedicated columns AND the raw bag).
        "tags": Jsonb(properties.get("tags", {})),
    }


def upsert(features, *, area_label=None, batch_size=BATCH_SIZE):
    """UPSERT a list of transformed feature dicts into ``features``.

    Opens one connection and commits once -- a single transaction for the whole
    call. Returns the number of rows sent.
    """
    params_list = [feature_to_params(f) for f in features]
    if not params_list:
        # overpass.fetch already guards the 0-element case; belt-and-suspenders.
        print(f"ingest: nothing to UPSERT for {area_label or 'area'} — skipping")
        return 0

    kwargs = connection_kwargs()
    with psycopg.connect(**kwargs) as conn:
        with conn.cursor() as cur:
            for start in range(0, len(params_list), batch_size):
                cur.executemany(INSERT_SQL, params_list[start:start + batch_size])
        conn.commit()

    label = f" for {area_label}" if area_label else ""
    print(f"ingest: UPSERTed {len(params_list)} rows{label}")
    return len(params_list)
