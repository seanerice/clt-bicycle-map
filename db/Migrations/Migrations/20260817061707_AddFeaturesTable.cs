using System;
using BikeMap.Migrations;
using Microsoft.EntityFrameworkCore.Migrations;
using NetTopologySuite.Geometries;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Migrations.Migrations
{
    /// <inheritdoc />
    public partial class AddFeaturesTable : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AlterDatabase()
                .Annotation("Npgsql:Enum:feature_type_enum", "road,path,route")
                .Annotation("Npgsql:PostgresExtension:postgis", ",,")
                .OldAnnotation("Npgsql:PostgresExtension:postgis", ",,");

            migrationBuilder.CreateTable(
                name: "features",
                columns: table => new
                {
                    id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    osm_type = table.Column<string>(type: "text", nullable: false),
                    osm_id = table.Column<long>(type: "bigint", nullable: false),
                    feature_type = table.Column<FeatureType>(type: "feature_type_enum", nullable: false),
                    geom = table.Column<Geometry>(type: "geometry(Geometry, 4326)", nullable: false),
                    cycleway_left = table.Column<string>(type: "text", nullable: true),
                    cycleway_right = table.Column<string>(type: "text", nullable: true),
                    cycleway_left_buffer = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    cycleway_right_buffer = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    bicycle = table.Column<string>(type: "text", nullable: true),
                    route = table.Column<string>(type: "text", nullable: true),
                    cycle_network = table.Column<string>(type: "text", nullable: true),
                    @ref = table.Column<string>(name: "ref", type: "text", nullable: true),
                    name = table.Column<string>(type: "text", nullable: true),
                    state = table.Column<string>(type: "text", nullable: true),
                    tags = table.Column<string>(type: "jsonb", nullable: false, defaultValueSql: "'{}'::jsonb"),
                    first_seen_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()"),
                    last_seen_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_features", x => x.id);
                    table.CheckConstraint("chk_features_geom_type", "GeometryType(geom) IN ('LINESTRING', 'MULTILINESTRING')");
                    table.CheckConstraint("chk_features_geom_valid", "ST_IsValid(geom)");
                    table.CheckConstraint("features_osm_type_check", "osm_type IN ('way', 'relation')");
                });

            migrationBuilder.CreateIndex(
                name: "idx_features_feature_type",
                table: "features",
                column: "feature_type");

            migrationBuilder.CreateIndex(
                name: "idx_features_geom",
                table: "features",
                column: "geom")
                .Annotation("Npgsql:IndexMethod", "GIST");

            migrationBuilder.CreateIndex(
                name: "ux_features_osm_key",
                table: "features",
                columns: new[] { "osm_type", "osm_id" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "features");

            migrationBuilder.AlterDatabase()
                .Annotation("Npgsql:PostgresExtension:postgis", ",,")
                .OldAnnotation("Npgsql:Enum:feature_type_enum", "road,path,route")
                .OldAnnotation("Npgsql:PostgresExtension:postgis", ",,");
        }
    }
}
