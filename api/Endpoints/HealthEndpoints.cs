using Microsoft.AspNetCore.Diagnostics.HealthChecks;

namespace Api.Endpoints;

/// <summary>
/// <c>GET /health</c> per docs/planning/layers/api-layer.md §7/§8. Backed by
/// <c>Microsoft.Extensions.Diagnostics.HealthChecks</c> with the
/// <c>AddNpgSql()</c> check registered in Program.cs, which runs a real
/// query against PostGIS through the same <c>NpgsqlDataSource</c> the rest
/// of the app uses — this returns <c>200</c> only when that query actually
/// succeeds, and <c>503</c> otherwise (not just "the process is up"). This
/// is the endpoint docker-compose's <c>api</c> service healthcheck polls.
/// </summary>
public static class HealthEndpoints
{
    public static IEndpointRouteBuilder MapHealthEndpoints(this IEndpointRouteBuilder app)
    {
        // MapHealthChecks' default behavior already does exactly what we
        // need with no custom ResponseWriter: 200 when every registered
        // check reports Healthy, 503 when any reports Unhealthy.
        app.MapHealthChecks("/health", new HealthCheckOptions());

        return app;
    }
}
