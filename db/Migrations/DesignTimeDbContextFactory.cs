using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.Extensions.Configuration;
using Npgsql;

namespace BikeMap.Migrations;

/// <summary>
/// Lets `dotnet ef` commands (migrations add/database update/etc.) construct
/// a <see cref="BikeMapDbContext"/> from the CLI without a hosting
/// application/DI container — required for a class-library-only project like
/// this one.
///
/// Connection info is split between a committed, non-secret
/// appsettings.json (host/port/database/username — see
/// ConnectionStrings:Default) and the POSTGRES_PASSWORD environment
/// variable (the same one docker-compose reads from a local, gitignored
/// .env — see db/.env.example). This keeps the password out of source
/// control while everything else stays easy to read/change.
///
/// For non-local scenarios (CI, etc.) the entire connection string can be
/// overridden via the BIKEMAP_CONNECTION_STRING environment variable.
/// </summary>
public class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<BikeMapDbContext>
{
    public BikeMapDbContext CreateDbContext(string[] args)
    {
        var connectionString = Environment.GetEnvironmentVariable("BIKEMAP_CONNECTION_STRING");

        if (string.IsNullOrWhiteSpace(connectionString))
        {
            var configuration = new ConfigurationBuilder()
                .SetBasePath(AppContext.BaseDirectory)
                .AddJsonFile("appsettings.json", optional: false)
                .Build();

            var builder = new NpgsqlConnectionStringBuilder(
                configuration.GetConnectionString("Default"))
            {
                Password = Environment.GetEnvironmentVariable("POSTGRES_PASSWORD"),
            };

            connectionString = builder.ConnectionString;
        }

        var optionsBuilder = new DbContextOptionsBuilder<BikeMapDbContext>();
        optionsBuilder.UseNpgsql(connectionString, o => o.UseNetTopologySuite());

        return new BikeMapDbContext(optionsBuilder.Options);
    }
}
