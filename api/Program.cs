using BikeMap.Migrations;
using NetTopologySuite.IO.Converters;
using Npgsql;

var builder = WebApplication.CreateBuilder(args);

// --- Connection string: non-secret parts come from config
// (ConnectionStrings:Postgis, appsettings.json/appsettings.Development.json),
// the password is layered on from the POSTGRES_PASSWORD env var — the same
// one docker-compose and db/Migrations/DesignTimeDbContextFactory.cs read.
// See db/Migrations/DesignTimeDbContextFactory.cs for the identical pattern.
var connectionStringBuilder = new NpgsqlConnectionStringBuilder(
    builder.Configuration.GetConnectionString("Postgis"));

var postgresPassword = Environment.GetEnvironmentVariable("POSTGRES_PASSWORD");
if (!string.IsNullOrEmpty(postgresPassword))
{
    connectionStringBuilder.Password = postgresPassword;
}

var connectionString = connectionStringBuilder.ConnectionString;

// --- NpgsqlDataSource: registered as a singleton so it's shared across
// requests (Npgsql's recommended pattern), with NetTopologySuite geometry
// support and the feature_type_enum <-> FeatureType mapping wired up, same
// as db/Migrations/DesignTimeDbContextFactory.cs does for `dotnet ef`.
var dataSourceBuilder = new NpgsqlDataSourceBuilder(connectionString);
dataSourceBuilder.UseNetTopologySuite();
dataSourceBuilder.MapEnum<FeatureType>("feature_type_enum");
var dataSource = dataSourceBuilder.Build();

builder.Services.AddSingleton(dataSource);

// --- GeoJSON System.Text.Json converters (NetTopologySuite.IO.GeoJSON4STJ)
// registered against the JSON options minimal API's built-in JSON result
// handling uses, so later stories' endpoints can return NTS Feature /
// FeatureCollection types directly without per-endpoint serializer setup.
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.Converters.Add(new GeoJsonConverterFactory());
});

var app = builder.Build();

// No routes registered yet beyond ASP.NET Core's defaults — /features and
// /health land in later stories (2.7-2.12).

app.Run();
