using Microsoft.EntityFrameworkCore;

namespace BikeMap.Migrations;

/// <summary>
/// EF Core context for the `bikemap` PostGIS database. Story 1.5 scaffolded
/// this with zero entities; story 1.6 adds the `features` table mapping —
/// see docs/planning/layers/persistence-layer.md §1.1 for the authoritative
/// schema.
/// </summary>
public class BikeMapDbContext : DbContext
{
    public BikeMapDbContext(DbContextOptions<BikeMapDbContext> options)
        : base(options)
    {
    }

    public DbSet<Feature> Features => Set<Feature>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        // `feature_type` is a real Postgres ENUM, not TEXT+CHECK — see
        // persistence-layer.md §1.3/§9. Npgsql maps the Postgres enum type
        // directly to the FeatureType C# enum.
        modelBuilder.HasPostgresEnum<FeatureType>(name: "feature_type_enum");

        modelBuilder.Entity<Feature>(entity =>
        {
            entity.ToTable("features", t =>
            {
                t.HasCheckConstraint(
                    "features_osm_type_check",
                    "osm_type IN ('way', 'relation')");
                t.HasCheckConstraint("chk_features_geom_valid", "ST_IsValid(geom)");
                t.HasCheckConstraint(
                    "chk_features_geom_type",
                    "GeometryType(geom) IN ('LINESTRING', 'MULTILINESTRING')");
            });

            entity.HasKey(f => f.Id);
            entity.Property(f => f.Id).HasColumnName("id").UseIdentityByDefaultColumn();

            entity.Property(f => f.OsmType)
                .HasColumnName("osm_type")
                .HasColumnType("text")
                .IsRequired();
            entity.Property(f => f.OsmId).HasColumnName("osm_id").IsRequired();

            entity.Property(f => f.FeatureType).HasColumnName("feature_type").IsRequired();

            // geometry(Geometry, 4326) — deliberately the NTS base Geometry
            // type, not narrowed to LineString/MultiLineString; see Feature.cs.
            entity.Property(f => f.Geom)
                .HasColumnName("geom")
                .HasColumnType("geometry(Geometry, 4326)")
                .IsRequired();

            entity.Property(f => f.CyclewayLeft).HasColumnName("cycleway_left");
            entity.Property(f => f.CyclewayRight).HasColumnName("cycleway_right");
            entity.Property(f => f.CyclewayLeftBuffer)
                .HasColumnName("cycleway_left_buffer")
                .HasDefaultValue(false)
                .IsRequired();
            entity.Property(f => f.CyclewayRightBuffer)
                .HasColumnName("cycleway_right_buffer")
                .HasDefaultValue(false)
                .IsRequired();

            entity.Property(f => f.Bicycle).HasColumnName("bicycle");

            entity.Property(f => f.Route).HasColumnName("route");
            entity.Property(f => f.CycleNetwork).HasColumnName("cycle_network");
            entity.Property(f => f.Ref).HasColumnName("ref");
            entity.Property(f => f.Name).HasColumnName("name");
            entity.Property(f => f.State).HasColumnName("state");

            entity.Property(f => f.Tags)
                .HasColumnName("tags")
                .HasColumnType("jsonb")
                .HasDefaultValueSql("'{}'::jsonb")
                .IsRequired();

            entity.Property(f => f.FirstSeenAt)
                .HasColumnName("first_seen_at")
                .HasDefaultValueSql("now()")
                .IsRequired();
            entity.Property(f => f.LastSeenAt)
                .HasColumnName("last_seen_at")
                .HasDefaultValueSql("now()")
                .IsRequired();

            entity.HasIndex(f => new { f.OsmType, f.OsmId })
                .IsUnique()
                .HasDatabaseName("ux_features_osm_key");

            entity.HasIndex(f => f.Geom)
                .HasDatabaseName("idx_features_geom")
                .HasMethod("GIST");

            entity.HasIndex(f => f.FeatureType)
                .HasDatabaseName("idx_features_feature_type");
        });
    }
}
