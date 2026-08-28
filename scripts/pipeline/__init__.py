"""clt-bicycle-map ingestion pipeline.

Config-driven replacement for the old monolithic ``scripts/fetch_data.py``:

- ``config``     -- reads/validates ``data/cities.json``
- ``transform``  -- pure OSM-feature -> render-property transforms (zero heavy imports)
- ``overpass``   -- Phase 1 Overpass fetch (disposable; removed in story 4.9)
- ``ingest``     -- psycopg batch UPSERT into the PostGIS ``features`` table
- ``__main__``   -- CLI: ``python -m scripts.pipeline --area <name|id> | --all``
"""
