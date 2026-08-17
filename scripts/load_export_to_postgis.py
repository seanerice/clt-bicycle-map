"""
One-off validation loader for Story 1.7.

THROWAWAY SCRIPT — this is explicitly NOT the real ingestion loader. It
loads the current production output of scripts/fetch_data.py
(data/export.geojson) into the `features` table created by the EF Core
migrations in db/Migrations/, to validate the schema described in
docs/planning/layers/persistence-layer.md end to end (in particular
Contract B's UPSERT pattern, §5) before the real ingestion loader exists.
A future, unrelated epic replaces fetch_data.py's write_data() with the
real loader that writes straight to Postgres; this script gets deleted
once that lands. It is NOT wired into .github/workflows/osm-refresh.yml
and is not meant to be.

Usage (from repo root, with the `db` docker-compose service running and
POSTGRES_PASSWORD set in the environment — same convention docker-compose
and db/Migrations/DesignTimeDbContextFactory.cs use, see .env.example):

    pip install -r scripts/requirements.txt
    python scripts/load_export_to_postgis.py
"""

import json
import os
import sys
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

REPO_ROOT = Path(__file__).resolve().parent.parent
EXPORT_PATH = REPO_ROOT / "data" / "export.geojson"

# This is the intended/correct highway_roads / highway_paths classification
# (i.e. what scripts/fetch_data.py's own highway_roads / highway_paths lists
# should contain) — not imported from fetch_data.py, since it performs a
# live Overpass fetch at module scope on import, so importing it here would
# trigger a network call. Note fetch_data.py currently has a known
# comma-typo bug between "tertiary_link" and "living_street" in its
# highway_roads list (tracked for a fix in a separate, later epic, not this
# script's job), which merges them into one bogus entry via Python string
# literal concatenation and silently drops any tertiary_link/living_street
# way before it ever reaches data/export.geojson. So this set is not a
# byte-for-byte copy of fetch_data.py's actual (buggy) list — that
# discrepancy is just currently inert against today's export.geojson, since
# no tertiary_link/living_street ways are present in it to classify.
# Used to re-derive each way feature's road-vs-path classification exactly
# as transform_way_feature does, from the `highway` tag. This is needed
# because the export file does not persist that classification as its own
# field for road features (transform_path_feature adds a "highwayType":
# "path" marker, but transform_road_feature adds no equivalent marker —
# and per persistence-layer.md §1.2, "highwayType" isn't stored in the DB
# at all since it's redundant with feature_type = 'path'), so recomputing
# from `highway` is the accurate approach rather than trusting an
# inconsistently-present export-file marker.
HIGHWAY_ROADS = {
    "motorway", "trunk", "primary", "secondary", "tertiary", "highway",
    "residential", "unclassified", "motorway_link", "trunk_link",
    "primary_link", "secondary_link", "tertiary_link", "living_street",
    "service", "pedestrian", "track", "bus_guideway", "escape", "raceway",
    "road", "busway",
}
HIGHWAY_PATHS = {
    "footway", "bridleway", "steps", "corridor", "path", "via_ferrata",
    "cycleway",
}

# Exact pattern from docs/planning/layers/persistence-layer.md §5.
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


def connection_kwargs():
    password = os.environ.get("POSTGRES_PASSWORD")
    if not password:
        sys.exit(
            "POSTGRES_PASSWORD is not set. Set it in your environment "
            "(e.g. via the repo-root .env, the same file docker-compose "
            "and db/Migrations read — see .env.example) before running "
            "this script."
        )
    return {
        "host": os.environ.get("POSTGRES_HOST", "localhost"),
        "port": int(os.environ.get("POSTGRES_PORT", "5432")),
        "dbname": os.environ.get("POSTGRES_DB", "bikemap"),
        "user": os.environ.get("POSTGRES_USER", "bikemap"),
        "password": password,
    }


def derive_feature_type(osm_type, highway):
    if osm_type == "relation":
        return "route"
    if highway in HIGHWAY_PATHS:
        return "path"
    if highway in HIGHWAY_ROADS:
        return "road"
    raise ValueError(
        f"Cannot classify feature_type for osm_type={osm_type!r} "
        f"highway={highway!r}"
    )


def feature_to_params(feature):
    properties = feature["properties"]
    raw_type = properties.get("type")

    # --- Known workaround for a pre-existing bug in fetch_data.py, tracked
    # for a fix in a later, unrelated epic — not addressed here. ---
    # transform_relation_feature does:
    #     {**feature["properties"], **feature["properties"]["tags"]}
    # which spreads OSM's own tag `tags["type"] == "route"` over the
    # original osm2geojson-assigned `properties["type"] == "relation"`,
    # clobbering it. So in the current export, every relation-derived
    # feature has properties.type == "route", never "relation" — confirmed
    # directly against data/export.geojson: of 2726 features, 2642 have
    # type == "way", 84 have type == "route", and zero have type ==
    # "relation". Since this loader only ever targets today's
    # already-produced export.geojson (not a general-purpose ingestion
    # path), treating any non-"way" `type` as a relation is safe here. This
    # is NOT a general rule for arbitrary OSM data — it only holds because
    # every non-way feature in the current pipeline output happens to be a
    # route relation (route=bicycle), per the Overpass query in
    # fetch_data.py.
    #
    # Note this same spread pattern is also applied to WAYS, by
    # transform_road_feature/transform_path_feature — so this check also
    # assumes no way in the export carries its own OSM `type` tag (valid
    # but uncommon OSM tagging, e.g. type=disused — unrelated to
    # osm2geojson's own top-level `type: "way"` field), which would clobber
    # properties.type the same way relations' tags do and cause that way to
    # be misclassified as a relation here too. Confirmed programmatically
    # not to occur in the current export.geojson (0 affected features), but
    # not structurally guaranteed for a hypothetical future export.
    osm_type = "way" if raw_type == "way" else "relation"

    highway = properties.get("highway")
    feature_type = derive_feature_type(osm_type, highway)

    # cyclewayLeftBuffer/cyclewayRightBuffer are only ever present (as the
    # string "yes") when transform_road_feature's hasCyclewayBufferValue()
    # was truthy; absent otherwise. Map that to the boolean columns.
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
        # Full raw OSM tag bag, unfiltered — matches persistence-layer.md
        # §1.2's "tags" description. Deliberately the raw properties.tags
        # dict, not the whole computed `properties` object: the computed
        # object also carries pipeline-derived fields (cyclewayLeft,
        # bicycle, etc.) that already have dedicated columns above, plus
        # `nodes`/`id`/`type` bookkeeping that isn't OSM tag data.
        "tags": Jsonb(properties.get("tags", {})),
    }


def main():
    if not EXPORT_PATH.exists():
        sys.exit(f"{EXPORT_PATH} does not exist. Run scripts/fetch_data.py first.")

    with EXPORT_PATH.open(encoding="utf-8") as f:
        data = json.load(f)

    features = data["features"]
    print(f"Loaded {len(features)} features from {EXPORT_PATH}")

    params_list = [feature_to_params(feature) for feature in features]

    kwargs = connection_kwargs()
    with psycopg.connect(**kwargs) as conn:
        with conn.cursor() as cur:
            cur.executemany(INSERT_SQL, params_list)
        conn.commit()

    print(f"Upserted {len(params_list)} rows into features.")


if __name__ == "__main__":
    main()
