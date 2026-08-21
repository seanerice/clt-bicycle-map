using System.Net;
using System.Text.Json;

namespace Api.Tests;

/// <summary>
/// Story 2.14 — <c>WebApplicationFactory&lt;Program&gt;</c>-based integration
/// tests against the real docker-compose <c>db</c> service, asserting on
/// real end-to-end HTTP responses through the stack built in 2.6-2.13. Per
/// api-layer.md §9 / stories.md 2.14's acceptance criteria. Property
/// *shape* correctness (Contract A) is deliberately NOT this file's job —
/// see <c>ContractTests.cs</c> (story 2.15) for that; this file only checks
/// status codes, feature counts, and which <c>osm_id</c>s come back.
///
/// Each test method gets a fresh instance of this class (xUnit's default),
/// so <see cref="InitializeAsync"/> — which truncates and reseeds
/// <c>features</c> via <see cref="FeatureFixtures.ResetAsync"/> — runs
/// before every single test, giving the "leaves features clean between
/// tests" isolation stories.md 2.14 requires without any teardown step.
/// </summary>
[Collection(DatabaseCollection.Name)]
public class FeaturesEndpointsTests : IAsyncLifetime
{
    private readonly DatabaseFixture _db;
    private HttpClient _client = null!;

    public FeaturesEndpointsTests(DatabaseFixture db)
    {
        _db = db;
    }

    public async Task InitializeAsync()
    {
        await FeatureFixtures.ResetAsync(_db.ConnectionString);
        _client = _db.Factory.CreateClient();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    [Fact]
    public async Task GetFeatures_ValidBbox_ReturnsExactlyTheFeaturesInsideIt()
    {
        var response = await _client.GetAsync($"/features?bbox={FeatureFixtures.Bbox}");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var root = json.RootElement;

        Assert.Equal("FeatureCollection", root.GetProperty("type").GetString());

        var ids = root.GetProperty("features")
            .EnumerateArray()
            .Select(f => f.GetProperty("id").GetString())
            .ToList();

        Assert.Equal(3, ids.Count);
        Assert.Contains(FeatureFixtures.RoadFeatureId, ids);
        Assert.Contains(FeatureFixtures.PathFeatureId, ids);
        Assert.Contains(FeatureFixtures.RouteFeatureId, ids);

        // The feature outside the bbox must NOT come back — proves spatial
        // filtering actually excludes it, not just that it includes the
        // right ones.
        Assert.DoesNotContain(FeatureFixtures.OutsideFeatureId, ids);
    }

    [Fact]
    public async Task GetFeatures_ValidBboxContainingNothing_ReturnsEmptyFeatureCollectionNot404()
    {
        var response = await _client.GetAsync($"/features?bbox={FeatureFixtures.EmptyBbox}");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var root = json.RootElement;

        Assert.Equal("FeatureCollection", root.GetProperty("type").GetString());
        Assert.Empty(root.GetProperty("features").EnumerateArray());
    }

    [Theory]
    [InlineData("-80.9,35.1,-80.7")] // wrong arg count (3 values)
    [InlineData("-80.9,not-a-number,-80.7,35.3")] // non-numeric value
    [InlineData("-80.7,35.1,-80.9,35.3")] // swapped minLon/maxLon
    [InlineData("-80.9,35.3,-80.7,35.1")] // swapped minLat/maxLat
    public async Task GetFeatures_MalformedBbox_ReturnsBadRequest(string bbox)
    {
        var response = await _client.GetAsync($"/features?bbox={bbox}");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);

        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.True(json.RootElement.TryGetProperty("error", out _));
    }

    [Fact]
    public async Task GetFeatures_OversizedBbox_ReturnsBadRequest()
    {
        var response = await _client.GetAsync($"/features?bbox={FeatureFixtures.OversizedBbox}");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Health_ReturnsOkWhenTestDatabaseIsReachable()
    {
        var response = await _client.GetAsync("/health");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
