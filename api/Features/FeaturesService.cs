using System.Diagnostics;
using Api.Geo;
using BikeMap.Migrations;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using NetTopologySuite.Features;

namespace Api.Features;

/// <summary>
/// Orchestrates a <c>GET /features</c> request: validate the bbox
/// (<see cref="BboxParser"/>) -> query <see cref="FeaturesRepository"/> ->
/// shape rows into GeoJSON (<see cref="GeoJsonFeatureCollection"/>). Thin —
/// no HTTP or Dapper knowledge of its own, so it's callable/testable
/// independent of Kestrel.
/// </summary>
public sealed class FeaturesService
{
    private readonly FeaturesRepository _repository;
    private readonly IConfiguration _configuration;
    private readonly ILogger<FeaturesService> _logger;

    public FeaturesService(FeaturesRepository repository, IConfiguration configuration, ILogger<FeaturesService> logger)
    {
        _repository = repository;
        _configuration = configuration;
        _logger = logger;
    }

    /// <summary>
    /// Returns either a populated (possibly empty) <see cref="GeoJsonFeatureCollection"/>
    /// on success, or a null collection plus the specific validation error
    /// message on failure — mirrors <see cref="BboxParseResult"/>'s
    /// discriminated shape so <c>FeaturesEndpoints</c> doesn't need to
    /// re-derive the 400 message.
    ///
    /// Story 2.13: logs a successful request at Information (bbox, area,
    /// feature count, duration in ms) and a rejected one at Warning with the
    /// specific validation-failure reason — the same message that ends up in
    /// the 400 body, per api-layer.md §8. Unhandled exceptions (e.g. the DB
    /// being unreachable) are intentionally not caught here — they propagate
    /// to ASP.NET Core's default hosting diagnostics, which already logs
    /// them at Error with the full exception before the framework's default
    /// 500 response is returned.
    /// </summary>
    public async Task<(GeoJsonFeatureCollection? Collection, string? Error)> GetFeaturesAsync(
        string? bboxValue,
        CancellationToken cancellationToken = default)
    {
        var parseResult = BboxParser.Parse(bboxValue, _configuration);
        if (!parseResult.Success)
        {
            _logger.LogWarning(
                "GET /features rejected: bbox={BboxValue} reason={Reason}",
                bboxValue,
                parseResult.Error);
            return (null, parseResult.Error);
        }

        var bbox = parseResult.Bbox!;
        var areaSqDegrees = (bbox.MaxLon - bbox.MinLon) * (bbox.MaxLat - bbox.MinLat);

        var stopwatch = Stopwatch.StartNew();
        var rows = await _repository.QueryByBboxAsync(bbox, cancellationToken);

        var features = new List<GeoJsonFeature>(rows.Count);
        foreach (var row in rows)
        {
            features.Add(MapRow(row));
        }

        stopwatch.Stop();

        _logger.LogInformation(
            "GET /features bbox={MinLon},{MinLat},{MaxLon},{MaxLat} areaSqDegrees={AreaSqDegrees} featureCount={FeatureCount} durationMs={DurationMs}",
            bbox.MinLon,
            bbox.MinLat,
            bbox.MaxLon,
            bbox.MaxLat,
            areaSqDegrees,
            features.Count,
            stopwatch.Elapsed.TotalMilliseconds);

        return (new GeoJsonFeatureCollection(features), null);
    }

    // snake_case DB columns -> camelCase Contract A properties
    // (api-layer.md §3). Omit-if-null, not emit-null, matching
    // fetch_data.py's convention so `['has', 'cyclewayLeft']`-style Mapbox
    // filters keep working. `highwayType: "path"` is derived here, not
    // stored. `route`/`cycleNetwork`/`ref`/`name`/`state` pass through
    // unfiltered — `state == "proposed"` filtering stays UI-side
    // (architecture.md §5).
    private static GeoJsonFeature MapRow(FeatureRow row)
    {
        var properties = new AttributesTable();

        if (row.CyclewayLeft is not null)
        {
            properties.Add("cyclewayLeft", row.CyclewayLeft);
        }

        if (row.CyclewayRight is not null)
        {
            properties.Add("cyclewayRight", row.CyclewayRight);
        }

        if (row.CyclewayLeftBuffer)
        {
            properties.Add("cyclewayLeftBuffer", "yes");
        }

        if (row.CyclewayRightBuffer)
        {
            properties.Add("cyclewayRightBuffer", "yes");
        }

        if (row.Bicycle is not null)
        {
            properties.Add("bicycle", row.Bicycle);
        }

        if (row.Route is not null)
        {
            properties.Add("route", row.Route);
        }

        if (row.CycleNetwork is not null)
        {
            properties.Add("cycleNetwork", row.CycleNetwork);
        }

        if (row.Ref is not null)
        {
            properties.Add("ref", row.Ref);
        }

        if (row.Name is not null)
        {
            properties.Add("name", row.Name);
        }

        if (row.State is not null)
        {
            properties.Add("state", row.State);
        }

        if (row.FeatureType == FeatureType.Path)
        {
            properties.Add("highwayType", "path");
        }

        return new GeoJsonFeature
        {
            // Resolved 2026-08-20, story 2.1: Feature.id = "{osmType}/{osmId}",
            // not duplicated into properties. See api-layer.md §3/§10.
            Id = $"{row.OsmType}/{row.OsmId}",
            Geometry = row.Geom,
            Properties = properties,
        };
    }
}
