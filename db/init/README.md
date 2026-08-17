# db/init/

Scripts here are mounted read-only to `/docker-entrypoint-initdb.d` in the `db`
compose service. The official Postgres/PostGIS image only runs this directory
the **first** time a container starts against an empty data directory — it is
a one-shot bootstrap, not a repeatable migration mechanism. Once the schema
needs to evolve past its first version, ongoing changes go through an
explicit migration step (see docs/planning/layers/persistence-layer.md §6),
not this directory.

For now it holds a single script that enables the `postgis` extension, so a
freshly created database is immediately usable without a manual step. If a
later story (e.g. an EF Core migration) takes over creating the extension
itself, this file can be deleted — don't let both mechanisms try to own it.
