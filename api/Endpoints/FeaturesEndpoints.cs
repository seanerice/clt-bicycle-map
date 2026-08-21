using Api.Features;

namespace Api.Endpoints;

/// <summary>
/// <c>GET /features</c> per docs/planning/layers/api-layer.md §1/§2. A thin
/// adapter — parses the query string, delegates to <see cref="FeaturesService"/>,
/// translates the result to an HTTP response. No Dapper/SQL here.
/// Unhandled exceptions are left to propagate to ASP.NET Core's default
/// problem-details 500 response (no custom try/catch-all, per §2's "solo
/// side project" posture).
/// </summary>
public static class FeaturesEndpoints
{
    public static IEndpointRouteBuilder MapFeaturesEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/features", async (
            string? bbox,
            string? zoom, // Accepted, intentionally ignored — reserved query param name only, per api-layer.md §2's v1 deferral. No behavior depends on it.
            FeaturesService featuresService,
            CancellationToken cancellationToken) =>
        {
            var (collection, error) = await featuresService.GetFeaturesAsync(bbox, cancellationToken);

            if (collection is null)
            {
                return Results.Json(
                    new { error },
                    statusCode: StatusCodes.Status400BadRequest);
            }

            // Resolved 2026-08-20, story 2.4: application/geo+json for both
            // the "features found" and "empty FeatureCollection" cases.
            return Results.Json(
                collection,
                contentType: "application/geo+json",
                statusCode: StatusCodes.Status200OK);
        });

        return app;
    }
}
