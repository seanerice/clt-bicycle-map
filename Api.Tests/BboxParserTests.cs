using Api.Features;
using Microsoft.Extensions.Configuration;

namespace Api.Tests;

/// <summary>
/// Pure unit tests for <see cref="BboxParser"/> — no WebApplicationFactory,
/// no DB, per story 2.7's own testing AC. Covers each validation step in
/// order (api-layer.md §2): value-count/parse, range sanity, area cap.
/// </summary>
public class BboxParserTests
{
    private static IConfiguration ConfigWithMaxArea(double? maxAreaDegrees = null)
    {
        var data = new Dictionary<string, string?>();
        if (maxAreaDegrees is not null)
        {
            data["Features:MaxBboxAreaDegrees"] = maxAreaDegrees.Value.ToString("R");
        }

        return new ConfigurationBuilder().AddInMemoryCollection(data).Build();
    }

    private static readonly IConfiguration DefaultConfig = ConfigWithMaxArea();

    [Fact]
    public void Parse_ValidBbox_Succeeds()
    {
        var result = BboxParser.Parse("-80.9,35.1,-80.7,35.3", DefaultConfig);

        Assert.True(result.Success);
        Assert.Null(result.Error);
        Assert.NotNull(result.Bbox);
        Assert.Equal(-80.9, result.Bbox!.MinLon);
        Assert.Equal(35.1, result.Bbox.MinLat);
        Assert.Equal(-80.7, result.Bbox.MaxLon);
        Assert.Equal(35.3, result.Bbox.MaxLat);
    }

    [Fact]
    public void Parse_MissingBbox_Fails()
    {
        var result = BboxParser.Parse(null, DefaultConfig);

        Assert.False(result.Success);
        Assert.Null(result.Bbox);
        Assert.NotNull(result.Error);
    }

    [Theory]
    [InlineData("-80.9,35.1,-80.7")] // 3 values
    [InlineData("-80.9,35.1,-80.7,35.3,1.0")] // 5 values
    public void Parse_WrongValueCount_Fails(string bbox)
    {
        var result = BboxParser.Parse(bbox, DefaultConfig);

        Assert.False(result.Success);
        Assert.NotNull(result.Error);
    }

    [Fact]
    public void Parse_NonNumericValue_Fails()
    {
        var result = BboxParser.Parse("-80.9,thirty-five,-80.7,35.3", DefaultConfig);

        Assert.False(result.Success);
        Assert.NotNull(result.Error);
    }

    [Fact]
    public void Parse_SwappedLongitudeMinMax_Fails()
    {
        // minLon > maxLon
        var result = BboxParser.Parse("-80.7,35.1,-80.9,35.3", DefaultConfig);

        Assert.False(result.Success);
        Assert.NotNull(result.Error);
    }

    [Fact]
    public void Parse_SwappedLatitudeMinMax_Fails()
    {
        // minLat > maxLat
        var result = BboxParser.Parse("-80.9,35.3,-80.7,35.1", DefaultConfig);

        Assert.False(result.Success);
        Assert.NotNull(result.Error);
    }

    [Theory]
    [InlineData("-181,35.1,-80.7,35.3")] // minLon < -180
    [InlineData("-80.9,35.1,181,35.3")] // maxLon > 180
    public void Parse_OutOfRangeLongitude_Fails(string bbox)
    {
        var result = BboxParser.Parse(bbox, DefaultConfig);

        Assert.False(result.Success);
        Assert.NotNull(result.Error);
    }

    [Theory]
    [InlineData("-80.9,-91,-80.7,35.3")] // minLat < -90
    [InlineData("-80.9,35.1,-80.7,91")] // maxLat > 90
    public void Parse_OutOfRangeLatitude_Fails(string bbox)
    {
        var result = BboxParser.Parse(bbox, DefaultConfig);

        Assert.False(result.Success);
        Assert.NotNull(result.Error);
    }

    [Fact]
    public void Parse_AreaExactlyAtCap_Succeeds()
    {
        // (maxLon-minLon) * (maxLat-minLat) = 2 * 1 = 2, cap = 2.
        var config = ConfigWithMaxArea(2.0);
        var result = BboxParser.Parse("0,0,2,1", config);

        Assert.True(result.Success);
        Assert.NotNull(result.Bbox);
    }

    [Fact]
    public void Parse_AreaJustOverCap_Fails()
    {
        // (maxLon-minLon) * (maxLat-minLat) = 2.001 * 1 = 2.001 > cap of 2.
        var config = ConfigWithMaxArea(2.0);
        var result = BboxParser.Parse("0,0,2.001,1", config);

        Assert.False(result.Success);
        Assert.NotNull(result.Error);
    }

    [Fact]
    public void Parse_AreaCap_DefaultsWhenConfigMissing()
    {
        // No Features:MaxBboxAreaDegrees key at all -> default (2).
        var emptyConfig = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>()).Build();

        var withinDefault = BboxParser.Parse("0,0,1,1", emptyConfig); // area 1, under default 2
        var overDefault = BboxParser.Parse("0,0,3,1", emptyConfig); // area 3, over default 2

        Assert.True(withinDefault.Success);
        Assert.False(overDefault.Success);
    }
}
