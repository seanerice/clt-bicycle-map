# db/Migrations/

A minimal .NET class library whose only job is hosting EF Core migration
tooling (`dotnet ef migrations add`, `dotnet ef database update`) against
the `db` docker-compose service (PostGIS, see `../../docker-compose.yml`).

## Why this exists ahead of an `api/` project

Migration tooling for this project is EF Core migrations, not hand-written
SQL files — chosen because `Npgsql.EntityFrameworkCore.PostgreSQL` and its
NetTopologySuite plugin map Postgres `geometry` columns directly to the NTS
types a future ASP.NET Core API project will also use for the same tables
(see `docs/planning/layers/persistence-layer.md` §4).

`dotnet ef` needs a .NET project to run against, but the full `api/`
project (Epic 2) doesn't exist yet — building it out just to unblock
schema migrations would be backwards. So this project scaffolds *only*
what `dotnet ef` needs: package references, an (initially empty)
`BikeMapDbContext`, and a design-time factory. It is deliberately not a
web project and has no entities registered yet — story 1.6 adds the
`features` entity mapping here.

Once Epic 2 stands up `api/Api.csproj`, that project can reference this one
(or this one's contents can be absorbed into it) without a disruptive move
— nothing here is coupled to being a standalone class library forever.

## Running migrations

From this directory (`db/Migrations/`), with the `db` compose service
running and `POSTGRES_PASSWORD` set in the environment (e.g. via
`db/.env`, the same file docker-compose reads — see `../.env.example`):

```
dotnet ef database update
```

This applies any pending migrations. To add a new migration after changing
`BikeMapDbContext`:

```
dotnet ef migrations add <Name>
```

### How the connection string is resolved

`DesignTimeDbContextFactory` (used only by `dotnet ef`, not at runtime by
anything else — there is no runtime "anything else" yet) builds the
connection string from:
- `appsettings.json` (committed, non-secret): host/port/database/username.
- The `POSTGRES_PASSWORD` environment variable for the password — never
  committed, matches what docker-compose itself reads from `db/.env`.
- Or, if set, `BIKEMAP_CONNECTION_STRING` overrides all of the above with a
  full connection string (useful for CI or other non-local scenarios).
