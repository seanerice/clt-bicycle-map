# Build context is the repo root (not api/), since Api.csproj has a
# project reference to ../db/Migrations/Migrations.csproj — that project
# needs to be in the build context too. Build with:
#   docker build -f api/Dockerfile .
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

COPY api/Api.csproj api/Api.csproj
COPY db/Migrations/Migrations.csproj db/Migrations/Migrations.csproj
RUN dotnet restore api/Api.csproj

COPY api/ api/
COPY db/Migrations/ db/Migrations/
RUN dotnet publish api/Api.csproj -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime
WORKDIR /app
COPY --from=build /app .
EXPOSE 8080
ENTRYPOINT ["dotnet", "Api.dll"]
