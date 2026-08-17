# db/init/

Scripts here are mounted read-only to `/docker-entrypoint-initdb.d` in the `db`
compose service. The official Postgres/PostGIS image only runs this directory
the **first** time a container starts against an empty data directory — it is
a one-shot bootstrap, not a repeatable migration mechanism. Once the schema
needs to evolve past its first version, ongoing changes go through an
explicit migration step (see docs/planning/layers/persistence-layer.md §6),
not this directory.

This directory is currently empty. It previously held a single script that
enabled the `postgis` extension, but that responsibility moved to the EF
Core `InitialEmpty` migration (see `db/Migrations/Migrations/`), which is
now the sole owner of that DDL — don't reintroduce a script here that also
creates the extension.

The directory stays mounted (see `docker-compose.yml`) in case a future
story needs a genuine one-shot, pre-migration bootstrap step.
