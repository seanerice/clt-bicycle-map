import json
import requests
import re
from osm2geojson import json2geojson 

def fetch_data():
    url = 'http://overpass-api.de/api/interpreter'  # Overpass API URL
    query = f"""
        [out:json][timeout:25];
        area(id:3600177415)->.searchArea;
        (
            // query part for "cycleway:*=*"
            way[~"^cycleway:.*$"~"."](area.searchArea);
            way["highway"="cycleway"](area.searchArea);
            way["bicycle"="designated"](area.searchArea);
            way["bicycle"="yes"](area.searchArea);
            relation["route"="bicycle"](area.searchArea);
        );
        out body;
        >;
        out skel qt;
    """
    r = requests.get(url, params={'data': query})
    data = r.json()

    return data

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
    
    (n, p) = osm_unit_regex.match(value).groups()
    if float(n) > 0:
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
