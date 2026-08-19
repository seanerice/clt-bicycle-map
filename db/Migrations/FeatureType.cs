namespace BikeMap.Migrations;

/// <summary>
/// Mirrors the Postgres <c>feature_type_enum</c> type (see
/// docs/planning/layers/persistence-layer.md §1.1/§1.3/§9). Distinguishes
/// which Contract A property family a <see cref="Feature"/> row feeds:
/// roads (cycleway_left/right etc.), paths (bicycle designation), or route
/// relations (route/cycle_network/ref/name/state). Mapped to the Postgres
/// enum via <c>HasPostgresEnum&lt;FeatureType&gt;()</c> in
/// <see cref="BikeMapDbContext.OnModelCreating"/>, which is a real
/// classification with no OSM-native equivalent — not a passthrough of an
/// existing OSM tag value, hence a proper enum type rather than TEXT+CHECK.
/// </summary>
public enum FeatureType
{
    Road,
    Path,
    Route,
}
