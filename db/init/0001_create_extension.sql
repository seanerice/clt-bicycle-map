-- Bootstraps the postgis extension on first container start.
-- See db/init/README.md for why this directory holds only this.
CREATE EXTENSION IF NOT EXISTS postgis;
