"""Pure unit tests for scripts/pipeline/transform.py.

No DB, no network -- imports only the transform module. Covers the two
Epic 4 bug fixes (a regression test each, per stories.md 4.1) plus a
representative slice of the tag logic from application-layer.md §9.
"""

import pytest

from pipeline.transform import (
    hasCyclewayBufferValue,
    highway_roads,
    transform_data,
    transform_path_feature,
    transform_relation_feature,
    transform_road_feature,
    transform_way_feature,
)


def make_way(tags, osm_id=1):
    return {
        "type": "Feature",
        "properties": {"type": "way", "id": osm_id, "tags": dict(tags)},
        "geometry": {"type": "LineString", "coordinates": [[0.0, 0.0], [1.0, 1.0]]},
    }


def make_relation(tags, osm_id=1):
    return {
        "type": "Feature",
        "properties": {"type": "relation", "id": osm_id, "tags": dict(tags)},
        "geometry": {"type": "LineString", "coordinates": [[0.0, 0.0], [1.0, 1.0]]},
    }


class TestHighwayRoadsCommaBug:
    """Regression test for the missing comma between 'tertiary_link' and
    'living_street' in highway_roads (string-literal concatenation dropped
    every highway=living_street way)."""

    def test_list_contains_both_entries_separately(self):
        assert "living_street" in highway_roads
        assert "tertiary_link" in highway_roads
        assert "tertiary_linkliving_street" not in highway_roads

    def test_living_street_with_cycleway_routes_to_road_not_dropped(self):
        feature = make_way(
            {"highway": "living_street", "cycleway:left": "track", "cycleway:right": "lane"}
        )
        out = transform_way_feature(feature)
        assert out is not None, "living_street way was dropped (comma bug regressed)"
        assert out["properties"]["cyclewayLeft"] == "track"
        assert out["properties"]["cyclewayRight"] == "lane"
        assert out["properties"]["featureType"] == "road"

    def test_living_street_survives_transform_data(self):
        feature = make_way({"highway": "living_street", "cycleway": "lane"}, osm_id=99)
        result = transform_data({"features": [feature]})
        ids = [f["properties"]["id"] for f in result["features"]]
        assert 99 in ids


class TestOsmTypeClobberBug:
    """Regression test for transform_relation_feature spreading the OSM tag
    bag (which carries type=route) over the osm2geojson-assigned
    type=relation."""

    def test_route_relation_keeps_osmtype_relation(self):
        feature = make_relation(
            {"type": "route", "route": "bicycle", "network": "lcn", "name": "Little Sugar Creek Greenway"},
            osm_id=42,
        )
        out = transform_relation_feature(feature)
        assert out["properties"]["osmType"] == "relation"
        assert out["properties"]["featureType"] == "route"
        assert out["properties"]["id"] == 42
        # The clobber of properties["type"] itself is expected/unfixed --
        # osmType is what the loader keys on.
        assert out["properties"]["type"] == "route"

    def test_route_relation_via_transform_data(self):
        feature = make_relation({"type": "route", "route": "bicycle"}, osm_id=7)
        result = transform_data({"features": [feature]})
        assert len(result["features"]) == 1
        assert result["features"][0]["properties"]["osmType"] == "relation"


class TestTransformRoadFeature:
    def test_cycleway_left_right_independent(self):
        out = transform_road_feature(
            make_way({"highway": "residential", "cycleway:left": "track", "cycleway:right": "lane"})
        )
        assert out["properties"]["cyclewayLeft"] == "track"
        assert out["properties"]["cyclewayRight"] == "lane"

    def test_cycleway_both_applies_to_both_sides(self):
        out = transform_road_feature(
            make_way({"highway": "residential", "cycleway:both": "lane"})
        )
        assert out["properties"]["cyclewayLeft"] == "lane"
        assert out["properties"]["cyclewayRight"] == "lane"

    def test_bare_cycleway_falls_back_to_both_sides(self):
        out = transform_road_feature(
            make_way({"highway": "residential", "cycleway": "shared_lane"})
        )
        assert out["properties"]["cyclewayLeft"] == "shared_lane"
        assert out["properties"]["cyclewayRight"] == "shared_lane"

    def test_specific_side_wins_over_both_and_bare(self):
        out = transform_road_feature(
            make_way(
                {
                    "highway": "residential",
                    "cycleway": "shared_lane",
                    "cycleway:both": "lane",
                    "cycleway:left": "track",
                }
            )
        )
        assert out["properties"]["cyclewayLeft"] == "track"
        assert out["properties"]["cyclewayRight"] == "lane"

    def test_no_cycleway_tags_keys_absent(self):
        out = transform_road_feature(make_way({"highway": "residential"}))
        assert "cyclewayLeft" not in out["properties"]
        assert "cyclewayRight" not in out["properties"]

    def test_buffer_flag_emitted_only_when_truthy(self):
        out = transform_road_feature(
            make_way(
                {"highway": "residential", "cycleway:left": "lane", "cycleway:left:buffer": "1.5 m"}
            )
        )
        assert out["properties"]["cyclewayLeftBuffer"] == "yes"
        assert "cyclewayRightBuffer" not in out["properties"]


@pytest.mark.parametrize(
    "value, expected",
    [
        ("yes", True),
        ("no", False),
        ("0", False),
        (None, False),
        ("1.5 m", True),
        ("0 m", False),
        ("2", True),  # bare number must not throw
    ],
)
def test_has_cycleway_buffer_value(value, expected):
    assert hasCyclewayBufferValue(value) is expected


class TestTransformPathFeature:
    @pytest.mark.parametrize(
        "tags, expected_bicycle",
        [
            ({"highway": "cycleway"}, "designated"),
            ({"highway": "cycleway", "bicycle": "no"}, "designated"),
            ({"highway": "path", "bicycle": "designated"}, "designated"),
            ({"highway": "path", "bicycle": "yes"}, "yes"),
            ({"highway": "path"}, "unknown"),
            ({"highway": "footway", "bicycle": "yes"}, "yes"),
        ],
    )
    def test_bicycle_designation(self, tags, expected_bicycle):
        out = transform_path_feature(make_way(tags))
        assert out["properties"]["bicycle"] == expected_bicycle
        assert out["properties"]["highwayType"] == "path"
        assert out["properties"]["osmType"] == "way"
        assert out["properties"]["featureType"] == "path"


class TestTransformWayDispatcher:
    def test_road_highway_dispatches_to_road(self):
        out = transform_way_feature(make_way({"highway": "primary", "cycleway": "lane"}))
        assert out["properties"]["featureType"] == "road"

    def test_path_highway_dispatches_to_path(self):
        out = transform_way_feature(make_way({"highway": "path", "bicycle": "yes"}))
        assert out["properties"]["featureType"] == "path"

    def test_unknown_highway_returns_none(self):
        assert transform_way_feature(make_way({"barrier": "fence"})) is None

    def test_no_tags_returns_none(self):
        feature = {"type": "Feature", "properties": {"type": "way", "id": 1}, "geometry": None}
        assert transform_way_feature(feature) is None


class TestTransformDataSplit:
    def test_splits_route_road_path_and_drops_unknown(self):
        features = [
            make_relation({"type": "route", "route": "bicycle"}, osm_id=1),
            make_way({"highway": "residential", "cycleway": "lane"}, osm_id=2),
            make_way({"highway": "path", "bicycle": "designated"}, osm_id=3),
            make_way({"barrier": "fence"}, osm_id=4),
        ]
        result = transform_data({"features": features})
        by_id = {f["properties"]["id"]: f["properties"]["featureType"] for f in result["features"]}
        assert by_id == {1: "route", 2: "road", 3: "path"}
