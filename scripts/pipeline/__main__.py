"""CLI entry point: ``python -m scripts.pipeline --area <name|id> | --all``.

Per area the flow is: ``overpass.fetch`` -> ``transform.transform_data`` ->
``ingest.upsert``. Nothing writes ``export.geojson`` anymore -- features stay in
memory between fetch and UPSERT.
"""

import argparse
import sys

from . import config, ingest, overpass, transform


def _run_area(entry):
    """Fetch + transform + UPSERT one area. Returns the set of distinct
    ``(osm_type, osm_id)`` keys this area contributed to ``features`` (empty if
    the area was skipped)."""
    label = entry["name"]
    print(f"=== {label} ===")
    collection = overpass.fetch(entry)
    if collection is None:
        print(f"=== {label}: skipped (no data returned) ===")
        return set()
    features = transform.transform_data(collection)["features"]
    ingest.upsert(features, area_label=label)
    return {(f["properties"]["osmType"], f["properties"]["id"]) for f in features}


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="python -m scripts.pipeline",
        description="Fetch OSM cycling data per data/cities.json entry and UPSERT it into PostGIS.",
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--area",
        metavar="NAME|RELATION_ID",
        help="run exactly one cities.json entry, matched on name (case-insensitive) or osmRelationId",
    )
    group.add_argument(
        "--all",
        action="store_true",
        help="run every cities.json entry",
    )
    args = parser.parse_args(argv)

    cities = config.load_cities()

    if args.all:
        entries = cities
    else:
        entry = config.find_area(cities, args.area)
        if entry is None:
            parser.error(f"no data/cities.json entry matches {args.area!r}")
        entries = [entry]

    # Union the per-area key sets: a way inside two adjacent areas' area(id:)
    # results is sent once per area but is a single features row, so the
    # run-level total must dedupe rather than sum the per-area send counts.
    run_keys = set()
    for entry in entries:
        run_keys |= _run_area(entry)

    print(f"done: {len(run_keys)} distinct rows UPSERTed across {len(entries)} area(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
