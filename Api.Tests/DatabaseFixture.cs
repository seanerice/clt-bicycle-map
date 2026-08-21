using System.Diagnostics;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Npgsql;

namespace Api.Tests;

/// <summary>
/// <c>WebApplicationFactory&lt;Program&gt;</c> pinned to the "Development"
/// environment so it reliably picks up api/appsettings.Development.json's
/// <c>Host=localhost</c> Postgis connection string (matching the
/// docker-compose <c>db</c> service's port 5432 published to the host),
/// independent of whatever <c>ASPNETCORE_ENVIRONMENT</c> the ambient
/// shell/CI happens to have set. <c>POSTGRES_PASSWORD</c> must already be in
/// the process environment before this factory's host is first built (see
/// <see cref="DatabaseFixture.InitializeAsync"/>) — Program.cs reads it
/// directly via <c>Environment.GetEnvironmentVariable</c> at startup, same
/// as db/Migrations/DesignTimeDbContextFactory.cs.
/// </summary>
public sealed class ApiWebApplicationFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Development");
    }
}

/// <summary>
/// xUnit collection fixture (shared once across every test class in
/// <see cref="DatabaseCollection"/>) that stands up everything
/// <c>FeaturesEndpointsTests</c> (story 2.14) and <c>ContractTests</c>
/// (story 2.15) need: the docker-compose <c>db</c> service up and reachable,
/// EF Core migrations applied, and one shared <see cref="ApiWebApplicationFactory"/>.
///
/// Mirrors scripts/tests/conftest.py's <c>_db_ready</c> pattern (session-scoped,
/// idempotent <c>docker compose up -d db</c> + wait + migrate) rather than
/// reusing it directly — this is the C# equivalent, not a Python dependency.
/// Per-test isolation (truncate + reseed before each test) is NOT done here;
/// that's <see cref="FeatureFixtures.ResetAsync"/>, called from each test
/// class's own <c>IAsyncLifetime.InitializeAsync</c> so it runs once per
/// test method, not once per collection.
/// </summary>
public sealed class DatabaseFixture : IAsyncLifetime
{
    private static readonly string RepoRoot = FindRepoRoot();

    public string ConnectionString { get; private set; } = null!;
    public ApiWebApplicationFactory Factory { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        var password = ResolvePostgresPassword();

        // Program.cs (running inside the WebApplicationFactory host built
        // below) and DesignTimeDbContextFactory-style migration code both
        // read POSTGRES_PASSWORD straight from the process environment, not
        // from IConfiguration — set it here so both pick up the same value
        // docker-compose used to start `db`.
        Environment.SetEnvironmentVariable("POSTGRES_PASSWORD", password);

        await RunProcessAsync("docker", "compose up -d db", RepoRoot);
        await WaitForDatabaseReadyAsync(password);

        ConnectionString = new NpgsqlConnectionStringBuilder
        {
            Host = "localhost",
            Port = 5432,
            Database = "bikemap",
            Username = "bikemap",
            Password = password,
        }.ConnectionString;

        await ApplyMigrationsAsync(password);

        Factory = new ApiWebApplicationFactory();
    }

    public Task DisposeAsync()
    {
        Factory?.Dispose();
        return Task.CompletedTask;
    }

    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "docker-compose.yml")))
        {
            dir = dir.Parent;
        }

        if (dir is null)
        {
            throw new InvalidOperationException(
                $"Could not locate the repo root (docker-compose.yml) above {AppContext.BaseDirectory}.");
        }

        return dir.FullName;
    }

    /// <summary>
    /// Same value docker-compose's <c>db</c> service and
    /// db/Migrations/DesignTimeDbContextFactory.cs use — the environment
    /// variable if already set, otherwise read directly out of the
    /// repo-root, gitignored <c>.env</c> (see .env.example / CLAUDE.md's
    /// Database section) so `dotnet test` works standalone the same way
    /// `docker compose up db` already does, without requiring the invoker
    /// to export it by hand first.
    /// </summary>
    private static string ResolvePostgresPassword()
    {
        var password = Environment.GetEnvironmentVariable("POSTGRES_PASSWORD");
        if (!string.IsNullOrEmpty(password))
        {
            return password;
        }

        var envFile = Path.Combine(RepoRoot, ".env");
        if (File.Exists(envFile))
        {
            foreach (var line in File.ReadAllLines(envFile))
            {
                var trimmed = line.Trim();
                if (trimmed.StartsWith("POSTGRES_PASSWORD=", StringComparison.Ordinal))
                {
                    return trimmed["POSTGRES_PASSWORD=".Length..];
                }
            }
        }

        throw new InvalidOperationException(
            "POSTGRES_PASSWORD is not set and no repo-root .env file defines it. " +
            "Run `cp .env.example .env` first (see CLAUDE.md's Database section) " +
            "or set POSTGRES_PASSWORD in your environment, then re-run dotnet test.");
    }

    private static async Task WaitForDatabaseReadyAsync(string password, int timeoutSeconds = 60)
    {
        var deadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);
        Exception? lastError = null;

        var connectionString = new NpgsqlConnectionStringBuilder
        {
            Host = "localhost",
            Port = 5432,
            Database = "bikemap",
            Username = "bikemap",
            Password = password,
            Timeout = 3,
        }.ConnectionString;

        while (DateTime.UtcNow < deadline)
        {
            try
            {
                await using var connection = new NpgsqlConnection(connectionString);
                await connection.OpenAsync();
                return;
            }
            catch (Exception ex)
            {
                lastError = ex;
                await Task.Delay(1000);
            }
        }

        throw new InvalidOperationException(
            $"db service never became reachable within {timeoutSeconds}s.", lastError);
    }

    /// <summary>
    /// Applies pending EF Core migrations from db/Migrations by shelling out
    /// to <c>dotnet ef database update</c> — the same command
    /// scripts/tests/conftest.py's <c>_db_ready</c> fixture runs, and
    /// idempotent for the same reason (only applies pending migrations, a
    /// no-op once the schema is current).
    ///
    /// Deliberately NOT done in-process via
    /// <c>BikeMapDbContext.Database.Migrate()</c> (which would be simpler):
    /// api/Api.csproj pins Npgsql 10.0.3, while db/Migrations/Migrations.csproj
    /// pins Npgsql.EntityFrameworkCore.PostgreSQL 8.0.11 (itself built against
    /// an older Npgsql). Loaded together in this test process (Api.Tests
    /// references both projects), that version skew throws
    /// <c>TypeLoadException: Could not load type 'Npgsql.Internal.HackyEnumTypeMapping'</c>
    /// the moment EF Core's Npgsql provider tries to resolve enum type
    /// mappings — a real, pre-existing version mismatch between those two
    /// projects, not something to paper over here by changing either
    /// project's pinned package versions. Shelling out runs
    /// db/Migrations' `dotnet ef` tooling in its own process with its own
    /// dependency graph, the same isolation `dotnet ef` design-time commands
    /// always have, sidestepping the clash entirely.
    /// </summary>
    private static async Task ApplyMigrationsAsync(string password)
    {
        var migrationsDir = Path.Combine(RepoRoot, "db", "Migrations");

        var startInfo = new ProcessStartInfo("dotnet", "ef database update")
        {
            WorkingDirectory = migrationsDir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        startInfo.Environment["POSTGRES_PASSWORD"] = password;

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start 'dotnet ef database update'.");

        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        var stdout = await stdoutTask;
        var stderr = await stderrTask;

        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"'dotnet ef database update' (in {migrationsDir}) failed (exit {process.ExitCode}):\n{stdout}\n{stderr}");
        }
    }

    private static async Task RunProcessAsync(string fileName, string arguments, string workingDirectory)
    {
        var startInfo = new ProcessStartInfo(fileName, arguments)
        {
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException($"Failed to start '{fileName} {arguments}'.");

        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        var stderr = await stderrTask;
        await stdoutTask;

        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"'{fileName} {arguments}' failed (exit {process.ExitCode}): {stderr}");
        }
    }
}

/// <summary>
/// Groups <c>FeaturesEndpointsTests</c> and <c>ContractTests</c> so they
/// share one <see cref="DatabaseFixture"/> instance (one docker-compose
/// bring-up, one migration pass, one <see cref="ApiWebApplicationFactory"/>)
/// instead of duplicating that expensive setup per test class. xUnit also
/// runs test classes in the same collection sequentially, which matters
/// here since both classes truncate/reseed the same shared `features` table.
/// </summary>
[CollectionDefinition(Name)]
public sealed class DatabaseCollection : ICollectionFixture<DatabaseFixture>
{
    public const string Name = "Database";
}
