using System.Text.Json;
using System.Text.Json.Serialization;

namespace Api.Geo;

/// <summary>
/// Writes a <see cref="GeoJsonFeature"/> as
/// <c>{ "type": "Feature", "id": ..., "geometry": ..., "properties": ... }</c>.
/// Geometry/properties serialization is delegated back through
/// <see cref="JsonSerializer"/> using the same <paramref name="options"/>,
/// so it reuses whatever NTS geometry/attributes-table converters Program.cs
/// registered (<c>GeoJsonConverterFactory</c>) rather than duplicating that
/// logic here. Read is intentionally unsupported — this type only ever
/// appears in outbound API responses, never request bodies.
/// </summary>
public sealed class GeoJsonFeatureConverter : JsonConverter<GeoJsonFeature>
{
    public override GeoJsonFeature? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => throw new NotSupportedException($"{nameof(GeoJsonFeature)} is a response-only type; reading it is not supported.");

    public override void Write(Utf8JsonWriter writer, GeoJsonFeature value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();
        writer.WriteString("type", "Feature");
        writer.WriteString("id", value.Id);
        writer.WritePropertyName("geometry");
        JsonSerializer.Serialize(writer, value.Geometry, options);
        writer.WritePropertyName("properties");
        JsonSerializer.Serialize(writer, value.Properties, options);
        writer.WriteEndObject();
    }
}

/// <summary>
/// Writes a <see cref="GeoJsonFeatureCollection"/> as
/// <c>{ "type": "FeatureCollection", "features": [ ... ] }</c>, delegating
/// each element to <see cref="GeoJsonFeatureConverter"/>. An empty
/// <c>Features</c> list writes a valid, empty <c>"features": []</c> array.
/// </summary>
public sealed class GeoJsonFeatureCollectionConverter : JsonConverter<GeoJsonFeatureCollection>
{
    public override GeoJsonFeatureCollection? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => throw new NotSupportedException($"{nameof(GeoJsonFeatureCollection)} is a response-only type; reading it is not supported.");

    public override void Write(Utf8JsonWriter writer, GeoJsonFeatureCollection value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();
        writer.WriteString("type", "FeatureCollection");
        writer.WritePropertyName("features");
        writer.WriteStartArray();
        foreach (var feature in value.Features)
        {
            JsonSerializer.Serialize(writer, feature, options);
        }
        writer.WriteEndArray();
        writer.WriteEndObject();
    }
}
