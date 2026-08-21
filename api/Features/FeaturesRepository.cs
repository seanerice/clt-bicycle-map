using BikeMap.Migrations;
using Dapper;
using NetTopologySuite.Geometries;
using Npgsql;

namespace Api.Features;

/// <summary>
/// One row from the <c>features</c> table, as read by
/// <see cref="FeaturesRepository"/> — raw column values, not yet shaped into
/// a GeoJSON <c>Feature</c> (that mapping is <c>FeaturesService</c>'s job,
/// per docs/planning/layers/api-layer.md §1/§3).
/// </summary>
public sealed class FeatureRow
{
    public string OsmType { get; set; } = null!;
    public long OsmId { get; set; }
    public FeatureType FeatureType { get; set; }
    public Geometry Geom { get; set; } = null!;

    public string? CyclewayLeft { get; set; }
    public string? CyclewayRight { get; set; }
    public bool CyclewayLeftBuffer { get; set; }
    public bool CyclewayRightBuffer { get; set; }

    public string? Bicycle { get; set; }

    public string? Route { get; set; }
    public string? CycleNetwork { get; set; }
    public string? Ref { get; set; }
    public string? Name { get; set; }
    public string? State { get; set; }
}

/// <summary>
/// Dapper query against <c>features</c> (Contract C, api-layer.md §3) — a
/// deliberate choice over EF Core for this one read query, independent of
/// EF Core being used for schema migrations (db/Migrations). Only
/// responsibility: run the bbox query, return typed rows. Does not
/// re-validate the bbox — callers must pass an already-validated
/// <see cref="Bbox"/> from <see cref="BboxParser"/>.
/// </summary>
public sealed class FeaturesRepository
{
    static FeaturesRepository()
    {
        // Dapper's default column-to-property matching is exact-name,
        // case-insensitive only — it doesn't strip underscores. The
        // `features` table uses snake_case columns (osm_type, cycle_network,
        // ...) while FeatureRow uses PascalCase properties; this flag makes
        // Dapper match them (osm_type -> OsmType) without per-column SQL
        // aliases.
        Dapper.DefaultTypeMap.MatchNamesWithUnderscores = true;
    }

    private readonly NpgsqlDataSource _dataSource;

    public FeaturesRepository(NpgsqlDataSource dataSource)
    {
        _dataSource = dataSource;
    }

    // `&&` (bounding-box overlap, hits the idx_features_geom GiST index)
    // followed by ST_Intersects (exact geometry-level correctness) — see
    // api-layer.md §3 for why both are written explicitly rather than
    // relying on ST_Intersects alone.
    //
    // Route relations (feature_type = 'route') are NOT clipped to the
    // requested bbox here — resolved 2026-08-20, story 2.2 ("don't clip"),
    // see docs/planning/layers/api-layer.md §3 for the full writeup and the
    // measured Cross Charlotte Trail payload-size comparison the decision
    // rests on. A feature whose geometry intersects the bbox at all is
    // returned with its complete stored geometry — same behavior as roads
    // and paths, so no per-feature-type branch is needed on this query.
    private const string Sql = """
        SELECT osm_type, osm_id, feature_type, geom,
               cycleway_left, cycleway_right, cycleway_left_buffer, cycleway_right_buffer,
               bicycle, route, cycle_network, ref, name, state
        FROM features
        WHERE geom && ST_MakeEnvelope(@minLon, @minLat, @maxLon, @maxLat, 4326)
          AND ST_Intersects(geom, ST_MakeEnvelope(@minLon, @minLat, @maxLon, @maxLat, 4326));
        """;

    public async Task<IReadOnlyList<FeatureRow>> QueryByBboxAsync(Bbox bbox, CancellationToken cancellationToken = default)
    {
        await using var connection = await _dataSource.OpenConnectionAsync(cancellationToken);

        var command = new CommandDefinition(
            Sql,
            new
            {
                minLon = bbox.MinLon,
                minLat = bbox.MinLat,
                maxLon = bbox.MaxLon,
                maxLat = bbox.MaxLat,
            },
            cancellationToken: cancellationToken);

        var rows = await connection.QueryAsync<FeatureRow>(command);
        return rows.AsList();
    }
}
