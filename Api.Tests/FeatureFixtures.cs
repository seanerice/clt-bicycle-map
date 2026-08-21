using Npgsql;

namespace Api.Tests;

/// <summary>
/// The fixed fixture feature set shared by <c>FeaturesEndpointsTests</c>
/// (story 2.14) and <c>ContractTests</c> (story 2.15), per stories.md's
/// description of both: "one road with cycleway_right='lane', one path with
/// bicycle='designated', one route relation, and one feature entirely
/// outside the test bbox." <see cref="ResetAsync"/> truncates and reseeds
/// this exact set — called from each test class's own
/// <c>IAsyncLifetime.InitializeAsync</c> so it runs before every test
/// method, giving the "clean between tests" isolation both stories require.
///
/// All SQL here is fixed, developer-authored literal text (test fixture
/// data, never user input), so it's inlined directly rather than
/// parameterized — same posture as scripts/tests' hand-written fixture
/// rows.
/// </summary>
public static class FeatureFixtures
{
    // Contains the road/path/route fixtures below (all within
    // lon -80.90..-80.80, lat 35.10..35.20) but not the "outside" fixture.
    // Area = 0.1 * 0.1 = 0.01 sq degrees, comfortably under the 2 sq-degree
    // cap (BboxParser.DefaultMaxBboxAreaDegrees / Features:MaxBboxAreaDegrees).
    public const string Bbox = "-80.90,35.10,-80.80,35.20";

    // Valid, under the cap, but contains none of the fixture rows.
    public const string EmptyBbox = "10,10,10.1,10.1";

    // Valid range values, but area = 5 * 5 = 25 sq degrees, over the 2
    // sq-degree cap.
    public const string OversizedBbox = "-85,30,-80,35";

    public const string RoadFeatureId = "way/900001";
    public const string PathFeatureId = "way/900002";
    public const string RouteFeatureId = "relation/900003";
    public const string OutsideFeatureId = "way/900004";

    public const string RouteName = "Test Fixture Route";
    public const string RouteRef = "TFR 1";
    public const string RouteCycleNetwork = "ncn";
    public const string RouteState = "existing";

    private const string ResetSql = """
        TRUNCATE TABLE features RESTART IDENTITY;

        INSERT INTO features
            (osm_type, osm_id, feature_type, geom,
             cycleway_left, cycleway_right, cycleway_left_buffer, cycleway_right_buffer,
             bicycle, route, cycle_network, ref, name, state)
        VALUES
            -- Road, inside the test bbox, buffered right lane.
            ('way', 900001, 'road', ST_GeomFromText('LINESTRING(-80.85 35.15, -80.84 35.16)', 4326),
             NULL, 'lane', false, true,
             NULL, NULL, NULL, NULL, NULL, NULL),
            -- Path, inside the test bbox, designated for bicycles.
            ('way', 900002, 'path', ST_GeomFromText('LINESTRING(-80.86 35.12, -80.85 35.13)', 4326),
             NULL, NULL, false, false,
             'designated', NULL, NULL, NULL, NULL, NULL),
            -- Route relation, inside the test bbox.
            ('relation', 900003, 'route', ST_GeomFromText('LINESTRING(-80.87 35.11, -80.83 35.19)', 4326),
             NULL, NULL, false, false,
             NULL, 'bicycle', 'ncn', 'TFR 1', 'Test Fixture Route', 'existing'),
            -- Road, entirely outside the test bbox — proves spatial filtering
            -- actually excludes it, not just includes the right ones.
            ('way', 900004, 'road', ST_GeomFromText('LINESTRING(-81.50 35.50, -81.49 35.51)', 4326),
             NULL, 'lane', false, false,
             NULL, NULL, NULL, NULL, NULL, NULL);
        """;

    public static async Task ResetAsync(string connectionString)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();

        await using var command = new NpgsqlCommand(ResetSql, connection);
        await command.ExecuteNonQueryAsync();
    }
}
