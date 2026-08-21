using NetTopologySuite.Features;
using NetTopologySuite.Geometries;

namespace Api.Geo;

/// <summary>
/// A single GeoJSON Feature carrying a top-level RFC 7946 <c>id</c> — see
/// <see cref="GeoJsonFeatureConverter"/> for why this exists instead of
/// <c>NetTopologySuite.Features.Feature</c> directly.
/// </summary>
public sealed class GeoJsonFeature
{
    public required string Id { get; init; }
    public required Geometry Geometry { get; init; }
    public required IAttributesTable Properties { get; init; }
}

/// <summary>
/// A GeoJSON FeatureCollection of <see cref="GeoJsonFeature"/>s.
///
/// This — not <c>NetTopologySuite.Features.FeatureCollection</c> — is the
/// response type <c>FeaturesService</c>/<c>FeaturesEndpoints</c> use.
/// Reason: as installed (NetTopologySuite.Features 2.1.0-2.2.0, paired with
/// NetTopologySuite.IO.GeoJSON4STJ 4.0.0), NTS's own <c>Feature</c>/
/// <c>IFeature</c> types have no public <c>Id</c> property at all, and the
/// library's internal FeatureCollection JSON converter
/// (NetTopologySuite.IO.Converters.StjFeatureCollectionConverter) dispatches
/// each element through the <c>IFeature</c> interface's own converter
/// regardless of the concrete runtime type — so even a custom
/// <c>IFeature</c> implementation with an <c>Id</c> property silently loses
/// it once placed inside a real <c>FeatureCollection</c> (verified directly
/// against the installed package: a standalone custom-IFeature Feature
/// serializes its id correctly, but the same instance added via
/// <c>FeatureCollection.Add</c> does not — the collection converter ignores
/// it). There is no supported way to get a top-level GeoJSON <c>Feature.id</c>
/// out of this library version.
///
/// The resolved decision (docs/planning/layers/api-layer.md §3/§10, story
/// 2.1) requires exactly that: <c>Feature.id = "{osmType}/{osmId}"</c> at
/// the top level, not duplicated into <c>properties</c>. These two small
/// types plus <see cref="GeoJsonFeatureConverter"/>/
/// <see cref="GeoJsonFeatureCollectionConverter"/> give full, verified
/// control over the exact wire shape while still using NTS's own
/// <c>Geometry</c> and <c>IAttributesTable</c> types for the geometry and
/// properties bag, and still reusing <c>GeoJsonConverterFactory</c>
/// (Program.cs) for the actual geometry/attributes serialization.
/// </summary>
public sealed record GeoJsonFeatureCollection(IReadOnlyList<GeoJsonFeature> Features);
