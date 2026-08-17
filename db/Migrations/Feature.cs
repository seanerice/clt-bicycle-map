using NetTopologySuite.Geometries;

namespace BikeMap.Migrations;

/// <summary>
/// One row per OSM element (way or relation) contributing cycling
/// infrastructure — roads, paths, or route relations. See
/// docs/planning/layers/persistence-layer.md §1.1 for the authoritative
/// schema and rationale; this class and
/// <see cref="BikeMapDbContext.OnModelCreating"/> together are the EF Core
/// mapping of that schema. Property groups below correspond to the
/// Contract A property families keyed off <see cref="FeatureType"/>.
/// </summary>
public class Feature
{
    public long Id { get; set; }

    // Contract B natural key: identifies the source OSM element.
    public string OsmType { get; set; } = null!;
    public long OsmId { get; set; }

    // Which Contract A property family this row feeds.
    public FeatureType FeatureType { get; set; }

    // WGS84 lon/lat. LineString for ways; MultiLineString for relations
    // resolved from >1 disjoint member way. Mapped as the NTS base
    // Geometry type (not LineString/MultiLineString) — see
    // persistence-layer.md §1.1's note on chk_features_geom_type.
    public Geometry Geom { get; set; } = null!;

    // --- Roads (feature_type = 'road') ---
    public string? CyclewayLeft { get; set; }
    public string? CyclewayRight { get; set; }
    public bool CyclewayLeftBuffer { get; set; }
    public bool CyclewayRightBuffer { get; set; }

    // --- Paths (feature_type = 'path') ---
    public string? Bicycle { get; set; }

    // --- Routes (feature_type = 'route') ---
    public string? Route { get; set; }
    public string? CycleNetwork { get; set; }
    public string? Ref { get; set; }
    public string? Name { get; set; }
    public string? State { get; set; }

    // Full raw OSM tag bag, unfiltered.
    public string Tags { get; set; } = "{}";

    // Ingestion bookkeeping.
    public DateTimeOffset FirstSeenAt { get; set; }
    public DateTimeOffset LastSeenAt { get; set; }
}
