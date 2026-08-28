"""Read and validate ``data/cities.json``.

Replaces the four hardcoded ``fetch_data_for_area(...)`` calls in the old
``fetch_data.py``. Schema (application-layer.md §2, stories.md 4.1)::

    {
      "cities": [
        { "name": "Charlotte", "state": "NC", "osmRelationId": 177415, "bbox": null },
        { "name": "SomeRect",  "state": "NC", "osmRelationId": null,   "bbox": [minLon, minLat, maxLon, maxLat] }
      ]
    }

Per entry, **exactly one** of ``osmRelationId`` / ``bbox`` is set (the other
``null`` or omitted). ``osmRelationId`` is the RAW OSM relation id --
``overpass.py`` adds the ``3600000000`` Overpass area offset itself. ``bbox``,
when set, is ``[minLon, minLat, maxLon, maxLat]`` -- the same order as Contract
A's ``GET /features?bbox=...``.
"""

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CITIES_PATH = REPO_ROOT / "data" / "cities.json"

_NUMERIC = (int, float)


class ConfigError(ValueError):
    """Raised when ``data/cities.json`` is structurally invalid."""


def _is_number(value):
    # bool is an int subclass; a JSON true/false is never a valid coordinate.
    return isinstance(value, _NUMERIC) and not isinstance(value, bool)


def _validate_bbox(bbox, where):
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        raise ConfigError(f"{where}: bbox must be a length-4 array [minLon, minLat, maxLon, maxLat]")
    if not all(_is_number(x) for x in bbox):
        raise ConfigError(f"{where}: bbox elements must all be numbers, got {bbox!r}")
    min_lon, min_lat, max_lon, max_lat = bbox
    if min_lon > max_lon:
        raise ConfigError(f"{where}: bbox minLon ({min_lon}) > maxLon ({max_lon})")
    if min_lat > max_lat:
        raise ConfigError(f"{where}: bbox minLat ({min_lat}) > maxLat ({max_lat})")


def validate_entry(entry, index=0):
    """Validate one city entry; return it normalized (``osmRelationId`` / ``bbox``
    keys always present, unset one is ``None``). Raises ``ConfigError``."""
    where = f"cities[{index}]"
    if not isinstance(entry, dict):
        raise ConfigError(f"{where}: entry must be an object, got {type(entry).__name__}")

    name = entry.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ConfigError(f"{where}: 'name' must be a non-empty string")

    state = entry.get("state")
    if state is not None and not isinstance(state, str):
        raise ConfigError(f"{where} ({name}): 'state' must be a string or null")

    relation_id = entry.get("osmRelationId")
    bbox = entry.get("bbox")

    has_relation = relation_id is not None
    has_bbox = bbox is not None

    if has_relation and has_bbox:
        raise ConfigError(f"{where} ({name}): set exactly one of 'osmRelationId' / 'bbox', not both")
    if not has_relation and not has_bbox:
        raise ConfigError(f"{where} ({name}): set exactly one of 'osmRelationId' / 'bbox', neither is set")

    if has_relation:
        if isinstance(relation_id, bool) or not isinstance(relation_id, int) or relation_id <= 0:
            raise ConfigError(f"{where} ({name}): 'osmRelationId' must be a positive integer (raw OSM relation id)")
    else:
        _validate_bbox(bbox, f"{where} ({name})")

    return {
        "name": name,
        "state": state,
        "osmRelationId": relation_id if has_relation else None,
        "bbox": list(bbox) if has_bbox else None,
    }


def validate_cities(data):
    """Validate a parsed ``cities.json`` document; return the list of normalized
    entries. Raises ``ConfigError``."""
    if not isinstance(data, dict) or "cities" not in data:
        raise ConfigError("cities.json must be an object with a 'cities' array")
    cities = data["cities"]
    if not isinstance(cities, list) or not cities:
        raise ConfigError("cities.json 'cities' must be a non-empty array")
    return [validate_entry(entry, i) for i, entry in enumerate(cities)]


def load_cities(path=CITIES_PATH):
    """Load, parse, and validate ``cities.json``; return the normalized entry list."""
    path = Path(path)
    try:
        with path.open(encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        raise ConfigError(f"{path} does not exist")
    except json.JSONDecodeError as e:
        raise ConfigError(f"{path} is not valid JSON: {e}")
    return validate_cities(data)


def find_area(cities, key):
    """Return the entry whose ``name`` matches ``key`` case-insensitively, or
    whose ``osmRelationId`` matches ``int(key)``. ``None`` if nothing matches."""
    key_str = str(key).strip()
    lowered = key_str.lower()
    for entry in cities:
        if entry["name"].lower() == lowered:
            return entry
    if key_str.lstrip("-").isdigit():
        wanted = int(key_str)
        for entry in cities:
            if entry["osmRelationId"] == wanted:
                return entry
    return None
