"""Pure transform functions: OSM feature dicts -> render-property feature dicts.

Moved verbatim from the old ``scripts/fetch_data.py`` (lines 122-294) except for
the fixes called out in stories.md 4.1 / application-layer.md §5:

1. ``highway_roads`` was missing a comma between ``"tertiary_link"`` and
   ``"living_street"`` -- Python string-literal concatenation silently merged
   them into ``"tertiary_linkliving_street"`` and dropped every
   ``highway=living_street`` way. Comma added.
2. An explicit ``properties["osmType"]`` (``"way"`` / ``"relation"``) is set in
   all three transforms. ``transform_relation_feature`` spreads the OSM ``tags``
   bag over ``properties`` after the base spread, so a route relation's
   ``type: "route"`` tag clobbers the osm2geojson-assigned ``type: "relation"``,
   which would break the loader's ``(osm_type, osm_id)`` UPSERT key. No OSM tag
   is named ``osmType``, so it is collision-proof.
3. An explicit ``properties["featureType"]`` (``"road"`` / ``"path"`` /
   ``"route"``) is set in all three transforms so the loader (``ingest.py``) can
   key ``feature_type`` off which transform produced the row rather than
   re-deriving it from the ``highway`` tag (application-layer.md §6.3 bullet 2).

**Zero heavy imports** -- only the stdlib ``re`` -- so the pure-transform unit
tests import this module cheaply.
"""

import re

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
    "tertiary_link",
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
            "highwayType": "path",
            "osmType": "way",
            "featureType": "path"
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
            "cyclewayRight": cycleway_right_value,
            "osmType": "way",
            "featureType": "road"
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
                **feature["properties"]["tags"],
                "osmType": "relation",
                "featureType": "route"
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
