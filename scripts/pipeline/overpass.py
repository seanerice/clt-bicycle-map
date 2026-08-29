"""Phase 1 Overpass fetch -- disposable.

Builds a per-area Overpass QL query from a ``data/cities.json`` entry, runs it
through the exact retry / exponential-backoff loop the old ``fetch_data.py``
used, and converts the result to a GeoJSON feature collection via
``osm2geojson``. This whole module is removed in story 4.9 when the extract
pipeline replaces the Overpass fetch mechanism.

An ``osmRelationId`` entry becomes an ``area(id:3600000000 + relationId)`` scoped
query; a ``bbox`` entry becomes a global ``[bbox:S,W,N,E]`` query. The six
selection clauses and the ``highway=proposed`` exclusion are unchanged from
``fetch_data.py``.
"""

import json
import random
import time

import requests
from osm2geojson import json2geojson

OVERPASS_URL = "http://overpass-api.de/api/interpreter"

# Overpass turns a raw OSM relation id into an area id by adding this offset.
AREA_ID_OFFSET = 3600000000

_HEADERS = {"User-Agent": "clt-bicycle-map-fetcher/1.0 (contact: none)"}

# The six selection clauses, unchanged from fetch_data.py lines 17-22. ``{scope}``
# is ``(area.searchArea)`` for an osmRelationId entry, ``""`` for a bbox entry.
_SELECTION_CLAUSES = (
    'way[~"^cycleway:.*$"~"."]{scope};',
    'way["cycleway"~"."]{scope};',
    'way["highway"="cycleway"]{scope};',
    'way["bicycle"="designated"]{scope};',
    'way["bicycle"="yes"]{scope};',
    'relation["route"="bicycle"]{scope};',
)


def build_query(entry):
    """Return the Overpass QL string for a validated cities.json entry."""
    relation_id = entry.get("osmRelationId")
    bbox = entry.get("bbox")

    if relation_id is not None:
        header = f"area(id:{AREA_ID_OFFSET + relation_id})->.searchArea;"
        scope = "(area.searchArea)"
        global_settings = ""
    else:
        # bbox is [minLon, minLat, maxLon, maxLat]; Overpass wants S,W,N,E.
        min_lon, min_lat, max_lon, max_lat = bbox
        header = ""
        scope = ""
        global_settings = f"[bbox:{min_lat},{min_lon},{max_lat},{max_lon}]"

    selection = "\n                ".join(
        clause.format(scope=scope) for clause in _SELECTION_CLAUSES
    )

    return f"""
            [out:json][timeout:25]{global_settings};
            {header}
            (
                {selection}
            )->.all;
            (
                way["highway"="proposed"]{scope};
            )->.proposed;
            (.all; - .proposed;);
            out body;
            >;
            out skel qt;
        """


def _fetch_raw(query, label):
    """Run ``query`` with the fetch_data.py retry/backoff loop; return parsed JSON."""
    attempts = 5
    backoff = 15
    for attempt in range(1, attempts + 1):
        try:
            r = requests.get(
                OVERPASS_URL, params={"data": query}, headers=_HEADERS, timeout=60
            )
        except requests.RequestException as e:
            print(f"DEBUG: HTTP request exception for {label}: {e} (attempt {attempt}/{attempts})")
            if attempt == attempts:
                raise
            time.sleep(backoff)
            backoff *= 2
            continue

        text = r.text or ""
        print(
            f"DEBUG: {label} status={r.status_code} "
            f"content-type={r.headers.get('content-type')} length={len(text)} "
            f"(attempt {attempt}/{attempts})"
        )

        # Handle rate limiting explicitly.
        if r.status_code in (429, 504):
            ra = r.headers.get("Retry-After")
            if ra and ra.isdigit():
                wait = int(ra)
            else:
                if r.status_code == 504:
                    wait = min(backoff * 2, 60)
                else:
                    wait = backoff
                wait = wait + random.uniform(0, 1)
            print(f"DEBUG: {r.status_code} for {label}, sleeping {wait}s before retry")
            time.sleep(wait)
            backoff = min(backoff * 2, 60)
            continue

        if r.status_code != 200:
            snippet = text[:2000]
            print(f"DEBUG: non-200 response for {label}. Snippet:\n{snippet}")
            r.raise_for_status()

        try:
            return r.json()
        except json.JSONDecodeError:
            snippet = text[:2000]
            print(f"DEBUG: JSON decode failed for {label}. Snippet:\n{snippet}")
            if attempt == attempts:
                raise
            time.sleep(backoff)
            backoff *= 2
            continue

    raise RuntimeError(f"Exceeded {attempts} attempts fetching {label}")


def fetch(entry):
    """Fetch + convert one cities.json entry.

    Returns a GeoJSON ``FeatureCollection`` dict (``{"type": ..., "features": [...]}``)
    ready for ``transform.transform_data``. Returns ``None`` -- signalling "skip
    this area, do not UPSERT" -- when an ``area(id:)`` query comes back with zero
    elements (the relation is not in Overpass's area index yet); the caller must
    not pass an empty feature set on to the loader.
    """
    label = entry.get("name") or entry.get("osmRelationId") or "bbox-area"
    query = build_query(entry)
    raw = _fetch_raw(query, label)

    elements = raw.get("elements", [])
    if entry.get("osmRelationId") is not None and len(elements) == 0:
        print(
            f"WARNING: area(id:{AREA_ID_OFFSET + entry['osmRelationId']}) for "
            f"{label} returned 0 elements -- relation not in Overpass's area "
            f"index yet? Skipping this area (not UPSERTing an empty result)."
        )
        return None

    return json2geojson(raw, filter_used_refs=True)
