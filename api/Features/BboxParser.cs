using System.Globalization;
using Microsoft.Extensions.Configuration;

namespace Api.Features;

/// <summary>
/// A validated bbox, in WGS84 degrees (matching GeoJSON/OSM convention — see
/// docs/planning/layers/api-layer.md §2). Only ever constructed by
/// <see cref="BboxParser"/> after all validation passes.
/// </summary>
public sealed record Bbox(double MinLon, double MinLat, double MaxLon, double MaxLat);

/// <summary>
/// Discriminated result of <see cref="BboxParser.Parse"/> — a bare bool
/// isn't enough because <c>FeaturesEndpoints</c> needs the specific failure
/// message for the <c>{ "error": "..." }</c> 400 body (api-layer.md §2).
/// </summary>
public sealed class BboxParseResult
{
    private BboxParseResult(bool success, Bbox? bbox, string? error)
    {
        Success = success;
        Bbox = bbox;
        Error = error;
    }

    public bool Success { get; }
    public Bbox? Bbox { get; }
    public string? Error { get; }

    public static BboxParseResult Ok(Bbox bbox) => new(true, bbox, null);

    public static BboxParseResult Fail(string error) => new(false, null, error);
}

/// <summary>
/// Parses and validates the <c>bbox</c> query string value
/// (<c>minLon,minLat,maxLon,maxLat</c>) per
/// docs/planning/layers/api-layer.md §2. Pure and I/O-free — no DB, no
/// HttpContext dependency — so it's unit-testable with no test host
/// (see Api.Tests/BboxParserTests.cs).
/// </summary>
public static class BboxParser
{
    /// <summary>
    /// Default bbox area cap (sq degrees) when
    /// <c>Features:MaxBboxAreaDegrees</c> isn't configured — resolved
    /// 2026-08-20, story 2.3. See api-layer.md §2 for how this value was
    /// sanity-checked against the real loaded coverage-area extent.
    /// </summary>
    public const double DefaultMaxBboxAreaDegrees = 2.0;

    /// <summary>
    /// Validation runs in this exact order (api-layer.md §2):
    /// 1. Exactly 4 comma-separated values, all parse as floats.
    /// 2. Range sanity: -180 &lt;= minLon &lt; maxLon &lt;= 180 and
    ///    -90 &lt;= minLat &lt; maxLat &lt;= 90 (catches swapped min/max and
    ///    out-of-range coordinates).
    /// 3. Area cap: (maxLon-minLon)*(maxLat-minLat) against the
    ///    <c>Features:MaxBboxAreaDegrees</c> config value (default 2 if
    ///    missing).
    /// A missing <paramref name="bboxValue"/> (no <c>bbox</c> query param at
    /// all) is treated the same as a malformed one — step 1 fails it, there
    /// is no separate "missing" path.
    /// </summary>
    public static BboxParseResult Parse(string? bboxValue, IConfiguration configuration)
    {
        if (string.IsNullOrWhiteSpace(bboxValue))
        {
            return BboxParseResult.Fail(
                "bbox query parameter is required: minLon,minLat,maxLon,maxLat (4 comma-separated numbers)");
        }

        var parts = bboxValue.Split(',');
        if (parts.Length != 4)
        {
            return BboxParseResult.Fail(
                $"bbox must have exactly 4 comma-separated values (minLon,minLat,maxLon,maxLat), got {parts.Length}");
        }

        var values = new double[4];
        for (var i = 0; i < 4; i++)
        {
            if (!double.TryParse(parts[i], NumberStyles.Float, CultureInfo.InvariantCulture, out values[i]))
            {
                return BboxParseResult.Fail($"bbox value '{parts[i]}' is not a valid number");
            }
        }

        var minLon = values[0];
        var minLat = values[1];
        var maxLon = values[2];
        var maxLat = values[3];

        if (!(minLon >= -180 && minLon < maxLon && maxLon <= 180))
        {
            return BboxParseResult.Fail(
                "bbox longitude values must satisfy -180 <= minLon < maxLon <= 180 (check for swapped min/max or out-of-range values)");
        }

        if (!(minLat >= -90 && minLat < maxLat && maxLat <= 90))
        {
            return BboxParseResult.Fail(
                "bbox latitude values must satisfy -90 <= minLat < maxLat <= 90 (check for swapped min/max or out-of-range values)");
        }

        var maxAreaDegrees = configuration.GetValue<double?>("Features:MaxBboxAreaDegrees") ?? DefaultMaxBboxAreaDegrees;
        var area = (maxLon - minLon) * (maxLat - minLat);
        if (area > maxAreaDegrees)
        {
            return BboxParseResult.Fail(
                $"bbox area ({area.ToString("0.####", CultureInfo.InvariantCulture)} sq degrees) exceeds the maximum allowed ({maxAreaDegrees.ToString("0.####", CultureInfo.InvariantCulture)} sq degrees)");
        }

        return BboxParseResult.Ok(new Bbox(minLon, minLat, maxLon, maxLat));
    }
}
