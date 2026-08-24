// Fixture GeoJSON FeatureCollection for the mocked `/features` bbox API
// (stories 3.9/3.10). Coordinates are real-looking LineStrings clustered
// tightly around the app's default map center ([-80.8421784, 35.240988],
// zoom 10 — see bikemap-app.js#firstUpdated), well inside the rough
// -81.0..-80.7 lon / 35.1..35.3 lat box stories.md 3.9 calls for, so they
// render within the initial viewport regardless of exact test-browser
// viewport size.
//
// Covers at least one feature per style-layer filter condition
// (bikemap-app.js's five addLayer calls):
//   - cycling-route-lines / cycling-route-symbols: route === 'bicycle' && state !== 'proposed'
//   - cycling-paths: has('bicycle') && highwayType === 'path', bicycle === 'designated'
//   - cycling-lanes-right: has('cyclewayRight') && cyclewayRight !== 'no', value 'track'
//
// A second, `state: 'proposed'` route feature is included specifically to
// prove the `!= 'proposed'` filter branch actually excludes something, not
// just that the `== 'bicycle'` branch trivially includes everything.
const CYCLING_DATA_FIXTURE = {
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            properties: {
                route: 'bicycle',
                state: 'active',
                cycle_network: 'US:NC:Mecklenburg',
                ref: 'GW 1',
                name: 'Test Greenway'
            },
            geometry: {
                type: 'LineString',
                coordinates: [
                    // Long enough (~0.2 degrees, ~100+ screen px at the
                    // app's default zoom 10) for cycling-route-symbols'
                    // symbol-placement:"line" label to actually have room
                    // to place text along it — a too-short line silently
                    // gets skipped by Mapbox GL's label placement, which a
                    // short "real-looking" segment ran into initially.
                    [-80.95, 35.28],
                    [-80.90, 35.26],
                    [-80.85, 35.24],
                    [-80.75, 35.20]
                ]
            }
        },
        {
            type: 'Feature',
            properties: {
                route: 'bicycle',
                state: 'proposed',
                cycle_network: 'US:NC:Mecklenburg',
                ref: 'GW Proposed'
            },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [-80.836, 35.236],
                    [-80.833, 35.234]
                ]
            }
        },
        {
            type: 'Feature',
            properties: {
                bicycle: 'designated',
                highwayType: 'path'
            },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [-80.838, 35.239],
                    [-80.835, 35.238]
                ]
            }
        },
        {
            type: 'Feature',
            properties: {
                cyclewayRight: 'track'
            },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [-80.843, 35.243],
                    [-80.839, 35.244]
                ]
            }
        }
    ]
};

module.exports = { CYCLING_DATA_FIXTURE };
