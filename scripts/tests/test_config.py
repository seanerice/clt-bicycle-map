"""Pure unit tests for scripts/pipeline/config.py (cities.json validator).

No DB, no network. Also loads the committed data/cities.json to lock in the
seeded four cities and the raw-relation-id convention.
"""

import pytest

from pipeline import config
from pipeline.config import ConfigError


def _doc(entry):
    return {"cities": [entry]}


class TestValidatorRejects:
    def test_rejects_both_relation_and_bbox_set(self):
        with pytest.raises(ConfigError):
            config.validate_cities(
                _doc({"name": "X", "state": "NC", "osmRelationId": 123, "bbox": [0, 0, 1, 1]})
            )

    def test_rejects_neither_set(self):
        with pytest.raises(ConfigError):
            config.validate_cities(
                _doc({"name": "X", "state": "NC", "osmRelationId": None, "bbox": None})
            )

    def test_rejects_entry_with_both_keys_omitted(self):
        with pytest.raises(ConfigError):
            config.validate_cities(_doc({"name": "X", "state": "NC"}))

    def test_rejects_bbox_wrong_length(self):
        with pytest.raises(ConfigError):
            config.validate_cities(_doc({"name": "X", "bbox": [0, 0, 1]}))

    def test_rejects_bbox_non_numeric_element(self):
        with pytest.raises(ConfigError):
            config.validate_cities(_doc({"name": "X", "bbox": [0, 0, "1", 1]}))

    def test_rejects_bbox_bool_element(self):
        with pytest.raises(ConfigError):
            config.validate_cities(_doc({"name": "X", "bbox": [0, 0, True, 1]}))

    def test_rejects_bbox_min_lon_gt_max_lon(self):
        with pytest.raises(ConfigError):
            config.validate_cities(_doc({"name": "X", "bbox": [5, 0, 1, 1]}))

    def test_rejects_bbox_min_lat_gt_max_lat(self):
        with pytest.raises(ConfigError):
            config.validate_cities(_doc({"name": "X", "bbox": [0, 5, 1, 1]}))

    def test_rejects_missing_name(self):
        with pytest.raises(ConfigError):
            config.validate_cities(_doc({"state": "NC", "osmRelationId": 123}))

    def test_rejects_offset_style_relation_id_is_still_accepted_as_positive_int(self):
        # Not a hard rejection -- magnitude isn't validated -- but a negative or
        # zero id is rejected.
        with pytest.raises(ConfigError):
            config.validate_cities(_doc({"name": "X", "osmRelationId": 0}))

    def test_rejects_non_object_document(self):
        with pytest.raises(ConfigError):
            config.validate_cities([{"name": "X", "osmRelationId": 1}])

    def test_rejects_empty_cities_array(self):
        with pytest.raises(ConfigError):
            config.validate_cities({"cities": []})


class TestValidatorAccepts:
    def test_accepts_valid_relation_entry(self):
        out = config.validate_cities(
            _doc({"name": "Charlotte", "state": "NC", "osmRelationId": 177415, "bbox": None})
        )
        assert out[0]["osmRelationId"] == 177415
        assert out[0]["bbox"] is None

    def test_accepts_valid_bbox_entry(self):
        out = config.validate_cities(
            _doc({"name": "SomeRect", "state": "NC", "osmRelationId": None, "bbox": [-81.0, 35.0, -80.0, 36.0]})
        )
        assert out[0]["bbox"] == [-81.0, 35.0, -80.0, 36.0]
        assert out[0]["osmRelationId"] is None

    def test_accepts_bbox_with_omitted_relation_key(self):
        out = config.validate_cities(_doc({"name": "R", "bbox": [0, 0, 1, 1]}))
        assert out[0]["osmRelationId"] is None

    def test_accepts_degenerate_bbox_equal_bounds(self):
        # min == max is allowed (only min > max is rejected).
        out = config.validate_cities(_doc({"name": "R", "bbox": [1, 1, 1, 1]}))
        assert out[0]["bbox"] == [1, 1, 1, 1]


class TestSeededCitiesFile:
    def test_loads_the_four_seeded_cities_with_raw_relation_ids(self):
        cities = config.load_cities()
        by_name = {c["name"]: c for c in cities}
        assert set(by_name) == {"Charlotte", "Belmont", "Cramerton", "McAdenville"}
        assert by_name["Charlotte"]["osmRelationId"] == 177415
        assert by_name["Belmont"]["osmRelationId"] == 179740
        assert by_name["Cramerton"]["osmRelationId"] == 176891
        assert by_name["McAdenville"]["osmRelationId"] == 179731
        for c in cities:
            assert c["bbox"] is None
            # Raw ids, NOT the 3600000000-offset Overpass area form.
            assert c["osmRelationId"] < 3600000000
            assert c["state"] == "NC"


class TestFindArea:
    def test_find_by_name_case_insensitive(self):
        cities = config.load_cities()
        assert config.find_area(cities, "charlotte")["name"] == "Charlotte"
        assert config.find_area(cities, "McAdenville")["name"] == "McAdenville"

    def test_find_by_relation_id(self):
        cities = config.load_cities()
        assert config.find_area(cities, "179740")["name"] == "Belmont"
        assert config.find_area(cities, 176891)["name"] == "Cramerton"

    def test_no_match_returns_none(self):
        cities = config.load_cities()
        assert config.find_area(cities, "Raleigh") is None
        assert config.find_area(cities, "999999") is None
