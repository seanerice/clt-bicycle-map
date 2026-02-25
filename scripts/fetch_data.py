import json
import requests
import re
import time
from osm2geojson import json2geojson 

def fetch_data():
    # For performance, query each area separately and combine results.
    def fetch_data_for_area(area_id):
        url = 'http://overpass-api.de/api/interpreter'
        query = f"""
            [out:json][timeout:25];
            area(id:{area_id})->.searchArea;
            (
                way[~"^cycleway:.*$"~"."](area.searchArea);
                way["cycleway"~"."](area.searchArea);
                way["highway"="cycleway"](area.searchArea);
                way["bicycle"="designated"](area.searchArea);
                way["bicycle"="yes"](area.searchArea);
                relation["route"="bicycle"](area.searchArea);
            )->.all;
            (
                way["highway"="proposed"](area.searchArea);
            )->.proposed;
            (.all; - .proposed;);
            out body;
            >;
            out skel qt;
        """
        headers = {'User-Agent': 'clt-bicycle-map-fetcher/1.0 (contact: none)'}
        attempts = 5
        backoff = 1
        for attempt in range(1, attempts + 1):
            try:
                r = requests.get(url, params={'data': query}, headers=headers, timeout=60)
            except requests.RequestException as e:
                print(f"DEBUG: HTTP request exception for area {area_id}: {e} (attempt {attempt}/{attempts})")
                if attempt == attempts:
                    raise
                time.sleep(backoff)
                backoff *= 2
                continue

            text = r.text or ''
            print(f"DEBUG: area={area_id} status={r.status_code} content-type={r.headers.get('content-type')} length={len(text)} (attempt {attempt}/{attempts})")

            # Handle rate limiting explicitly
            if r.status_code == 429:
                ra = r.headers.get('Retry-After')
                try:
                    wait = int(ra) if ra is not None else backoff
                except Exception:
                    wait = backoff
                print(f"DEBUG: 429 for area {area_id}, sleeping {wait}s before retry")
                time.sleep(wait)
                backoff *= 2
                continue

            if r.status_code != 200:
                snippet = text[:2000]
                print(f"DEBUG: non-200 response for area {area_id}. Snippet:\n{snippet}")
                try:
                    with open(f"../data/overpass_area_{area_id}_resp.txt", "w", encoding="utf-8") as fh:
                        fh.write(snippet)
                except Exception:
                    pass
                r.raise_for_status()

            try:
                return r.json()
            except json.JSONDecodeError:
                snippet = text[:2000]
                print(f"DEBUG: JSON decode failed for area {area_id}. Snippet:\n{snippet}")
                try:
                    with open(f"../data/overpass_area_{area_id}_resp.txt", "w", encoding="utf-8") as fh:
                        fh.write(snippet)
                except Exception:
                    pass
                if attempt == attempts:
                    raise
                time.sleep(backoff)
                backoff *= 2
                continue

        raise RuntimeError(f"Exceeded {attempts} attempts fetching area {area_id}")

    # Fetch each area explicitly (no loop) for clearer flow
    d1 = fetch_data_for_area(3600177415)  # Charlotte
    d2 = fetch_data_for_area(3600179740)  # Belmont
    d3 = fetch_data_for_area(3600176891)  # Cramerton
    d4 = fetch_data_for_area(3600179731)  # McAdenville

    version = d1.get('version')
    osm3s = d1.get('osm3s')

    combined_elements = [*(d1.get('elements', [])), *(d2.get('elements', [])), *(d3.get('elements', [])), *(d4.get('elements', []))]

    return {
        'version': version or 0,
        'generator': 'combined',
        'osm3s': osm3s or {},
        'elements': combined_elements
    }

def write_data(data, path, minify=False):
    indent = 4
    separators = None
    if minify == True:
        indent = None
        separators = (',', ':')

    with open(path, mode="w") as f:
        f.write(json.dumps(data, indent=indent, separators=separators))

highway_roads = [
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "highway",
    "residential",
    "unclassified",
    "motorway_link",
    "trunk_link",
    "primary_link",
    "secondary_link",
    "tertiary_link"
    "living_street",
    "service",
    "pedestrian",
    "track",
    "bus_guideway",
    "escape",
    "raceway",
    "road",
    "busway"
]

highway_paths = [
    "footway",
    "bridleway",
    "steps",
    "corridor",
    "path",
    "via_ferrata",
    "cycleway"
]

# https://wiki.openstreetmap.org/wiki/Key:highway#Roads
def transform_path_feature(feature):
    properties = feature["properties"]["tags"]

    bicycle = "unknown"
    if properties.get("highway") == "cycleway" or properties.get("bicycle") == "designated":
        bicycle = "designated"
    elif properties.get("bicycle") == "yes":
        bicycle = "yes"

    new_feature = {
        **feature,
        "properties": {
            **feature["properties"],
            **feature["properties"]["tags"],
            "bicycle": bicycle,
            "highwayType": "path"
        }
    }

    return new_feature

osm_unit_regex = re.compile('^\s*(?P<n>[-+]?[0-9]?.?[0-9]*)\s*(?P<u>[a-zA-Z\'\"]*)$')

def hasCyclewayBufferValue(value):
    if value is None or value == "no" or value == "0":
        return False
    if value == "yes":
        return True
    
    ur_match = osm_unit_regex.match(value)
    if (ur_match):
        (n, p) = osm_unit_regex.match(value).groups()
        num = re.sub('[^0-9]','', n)
        if float(num) > 0:
            return True
    
    return False
    

# https://wiki.openstreetmap.org/wiki/Key:highway#Roads
def transform_road_feature(feature):
    properties = feature["properties"]["tags"]
    
    cycleway_left_value = (
        properties.get("cycleway:left") or
        properties.get("cycleway:both") or
        properties.get("cycleway")
    )
    cycleway_right_value = (
        properties.get("cycleway:right") or
        properties.get("cycleway:both") or
        properties.get("cycleway")
    )

    cycleway_right_buffer_value = (
        properties.get("cycleway:right:buffer") or
        properties.get("cycleway:both:buffer") or
        properties.get("cycleway:buffer")
    )

    cycleway_left_buffer_value = (
        properties.get("cycleway:left:buffer") or
        properties.get("cycleway:both:buffer") or
        properties.get("cycleway:buffer")
    )

    new_feature = {
        **feature,
        "properties": {
            **feature["properties"],
            **feature["properties"]["tags"],
            "cyclewayLeft": cycleway_left_value,
            "cyclewayRight": cycleway_right_value
        }
    }

    if not cycleway_left_value:
        del new_feature["properties"]["cyclewayLeft"]
    if not cycleway_right_value:
        del new_feature["properties"]["cyclewayRight"]
    if hasCyclewayBufferValue(cycleway_left_buffer_value):
        new_feature["properties"]["cyclewayLeftBuffer"] = "yes"
    if hasCyclewayBufferValue(cycleway_right_buffer_value):
        new_feature["properties"]["cyclewayRightBuffer"] = "yes"

    return new_feature

def transform_relation_feature(feature):
    if feature["properties"]["tags"]["type"] == "route":
        new_feature = {
            **feature,
            "properties": {
                **feature["properties"],
                **feature["properties"]["tags"]
            }
        }
        return new_feature

def transform_way_feature(feature):
    if not feature["properties"].get("tags"):
        return None
    
    if feature["properties"]["tags"].get("highway") in highway_roads:
        return transform_road_feature(feature)
    elif feature["properties"]["tags"].get("highway") in highway_paths:
        return transform_path_feature(feature)

def transform_data(data):
    relation_features = []
    way_features = []
    unknown_features = []

    for feature in data["features"]:
        if feature["properties"]["type"] == "relation":
            new_feature = transform_relation_feature(feature)
            if new_feature:
                relation_features.append(new_feature)
            else:
                unknown_features.append(feature)
        elif feature["properties"]["type"] == "way":
            new_feature = transform_way_feature(feature)
            if new_feature:
                way_features.append(new_feature)
            else:
                unknown_features.append(feature)
        else:
            unknown_features.append(feature)
    if unknown_features:
        print("Unknown features: ", len(unknown_features))
    print("relation features: ", len(relation_features))
    print("way features: ", len(way_features))

    features = [*relation_features, *way_features]
    return {
        "type": "FeatureCollection",
        "features": features
    }

geojson_data = json2geojson(fetch_data(), filter_used_refs=True)
transformed_data = transform_data(geojson_data)
write_data(transformed_data, "../data/export.geojson", minify=True)
