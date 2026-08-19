using Microsoft.EntityFrameworkCore;

namespace BikeMap.Migrations;

/// <summary>
/// EF Core context for the `bikemap` PostGIS database. Intentionally has zero
/// entities registered as of story 1.5 — this project exists only to host EF
/// Core migration tooling ahead of the `features` entity mapping (story 1.6)
/// and the future `api/` project. See db/Migrations/README.md.
/// </summary>
public class BikeMapDbContext : DbContext
{
    public BikeMapDbContext(DbContextOptions<BikeMapDbContext> options)
        : base(options)
    {
    }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        // Story 1.6 adds the `features` entity mapping (and the
        // `feature_type_enum` Postgres enum via HasPostgresEnum<FeatureType>())
        // here. Nothing is registered yet, by design.
    }
}
