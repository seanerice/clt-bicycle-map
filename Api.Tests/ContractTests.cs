using System.Net;
using System.Text.Json;

namespace Api.Tests;

/// <summary>
/// Story 2.15 — narrower and more surgical than <c>FeaturesEndpointsTests.cs</c>
/// (story 2.14): pins the exact property *shape* Contract A
/// (architecture.md §2) promises, independent of feature counts or spatial
/// filtering (that's 2.14's job — this file never asserts on how many
/// features come back, only what's inside each one's <c>properties</c>).
///
/// Shares fixture-loading infrastructure with <c>FeaturesEndpointsTests</c>
/// (<see cref="DatabaseFixture"/>, <see cref="FeatureFixtures"/>) rather than
/// duplicating the DB setup, per stories.md 2.14/2.15's shared-needs note.
/// </summary>
[Collection(DatabaseCollection.Name)]
public class ContractTests : IAsyncLifetime
{
    private readonly DatabaseFixture _db;
    private HttpClient _client = null!;
    private JsonElement _features;

    public ContractTests(DatabaseFixture db)
    {
        _db = db;
    }

    public async Task InitializeAsync()
    {
        await FeatureFixtures.ResetAsync(_db.ConnectionString);
        _client = _db.Factory.CreateClient();

        var response = await _client.GetAsync($"/features?bbox={FeatureFixtures.Bbox}");
        response.EnsureSuccessStatusCode();

        // Cloned so it stays valid after the owning JsonDocument would
        // otherwise be disposed — this element is read from every [Fact] in
        // this class.
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        _features = json.RootElement.GetProperty("features").Clone();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private JsonElement FeatureById(string id) =>
        _features.EnumerateArray().Single(f => f.GetProperty("id").GetString() == id);

    [Theory]
    [InlineData(FeatureFixtures.RoadFeatureId)]
    [InlineData(FeatureFixtures.PathFeatureId)]
    [InlineData(FeatureFixtures.RouteFeatureId)]
    public void Feature_IdMatchesStory21sResolvedEncoding(string expectedId)
    {
        // Story 2.1: Feature.id = "{osmType}/{osmId}" — asserting we can
        // find each fixture feature by that exact id (rather than just
        // "some feature came back") is itself the id-shape assertion.
        var feature = FeatureById(expectedId);

        Assert.Equal("Feature", feature.GetProperty("type").GetString());
        Assert.Equal(expectedId, feature.GetProperty("id").GetString());
    }

    [Fact]
    public void RoadFeature_CyclewayRightAndBufferRoundTripAsContractAStrings()
    {
        var props = FeatureById(FeatureFixtures.RoadFeatureId).GetProperty("properties");

        Assert.True(props.TryGetProperty("cyclewayRight", out var cyclewayRight));
        Assert.Equal(JsonValueKind.String, cyclewayRight.ValueKind);
        Assert.Equal("lane", cyclewayRight.GetString());

        // The critical assertion story 2.15 exists for: cycleway_right_buffer
        // = true in the fixture row must round-trip as the literal JSON
        // string "yes" — never a JSON boolean true, never 1, never absent.
        Assert.True(props.TryGetProperty("cyclewayRightBuffer", out var buffer));
        Assert.NotEqual(JsonValueKind.True, buffer.ValueKind);
        Assert.NotEqual(JsonValueKind.Number, buffer.ValueKind);
        Assert.Equal(JsonValueKind.String, buffer.ValueKind);
        Assert.Equal("yes", buffer.GetString());

        // cycleway_left / cycleway_left_buffer are NULL/false on this
        // fixture row — omitted, not emitted as null/false.
        Assert.False(props.TryGetProperty("cyclewayLeft", out _));
        Assert.False(props.TryGetProperty("cyclewayLeftBuffer", out _));

        // highwayType is path-only — must not leak onto a road feature.
        Assert.False(props.TryGetProperty("highwayType", out _));
        Assert.False(props.TryGetProperty("bicycle", out _));
    }

    [Fact]
    public void PathFeature_BicycleAndHighwayTypeRoundTrip()
    {
        var props = FeatureById(FeatureFixtures.PathFeatureId).GetProperty("properties");

        Assert.True(props.TryGetProperty("bicycle", out var bicycle));
        Assert.Equal(JsonValueKind.String, bicycle.ValueKind);
        Assert.Equal("designated", bicycle.GetString());

        Assert.True(props.TryGetProperty("highwayType", out var highwayType));
        Assert.Equal(JsonValueKind.String, highwayType.ValueKind);
        Assert.Equal("path", highwayType.GetString());

        // Road-only properties must not leak onto a path feature.
        Assert.False(props.TryGetProperty("cyclewayLeft", out _));
        Assert.False(props.TryGetProperty("cyclewayRight", out _));
    }

    [Fact]
    public void RouteFeature_RelationPropertiesRoundTripWithContractANamesAndCasing()
    {
        var props = FeatureById(FeatureFixtures.RouteFeatureId).GetProperty("properties");

        Assert.Equal("bicycle", props.GetProperty("route").GetString());
        Assert.Equal(FeatureFixtures.RouteName, props.GetProperty("name").GetString());
        Assert.Equal(FeatureFixtures.RouteRef, props.GetProperty("ref").GetString());
        Assert.Equal(FeatureFixtures.RouteState, props.GetProperty("state").GetString());

        // DB column cycle_network -> Contract A's camelCase cycleNetwork,
        // not the raw snake_case column name.
        Assert.Equal(FeatureFixtures.RouteCycleNetwork, props.GetProperty("cycleNetwork").GetString());
        Assert.False(props.TryGetProperty("cycle_network", out _));

        // highwayType is path-only — must not leak onto a route feature.
        Assert.False(props.TryGetProperty("highwayType", out _));
    }
}
