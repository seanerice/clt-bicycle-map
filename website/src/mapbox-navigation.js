
import { LitElement, html, css } from 'lit';
import { ContextConsumer } from '@lit/context';
import { mapContext } from './mapContext';
import mapboxgl from 'mapbox-gl';

export class MapboxNavigation extends LitElement {
    _mapConsumer = new ContextConsumer(
        this,
        {
            context: mapContext,
            subscribe: true,
            callback: (v) => this._mapChanged(v)
        }
    );

    static get properties() {
        return {
            placementMode: { type: String },
        };
    }

    get _map() {
        return this._mapConsumer.value;
    }

    _createGeojsonPoint(coords) {
        return {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    properties: {},
                    geometry: {
                        type: 'Point',
                        coordinates: coords
                    }
                }
            ]
        };
    }

    _placeEndPoint(coords) {
        const map = this._map;
        const geojsonData = this._createGeojsonPoint(coords);

        if (!map.getLayer('end')) {
            map.addLayer({
                id: 'end',
                type: 'circle',
                source: {
                    type: 'geojson',
                    data: this._createGeojsonPoint(geojsonData)
                },
                paint: {
                    'circle-radius': 10,
                    'circle-color': '#f30'
                }
            });
        }

        map.getSource('end')
            .setData(geojsonData);
    }

    _placeStartPoint(coords) {
        const map = this._map;
        const geojsonData = this._createGeojsonPoint(coords);

        if (!map.getLayer('start')) {
            map.addLayer({
                id: 'start',
                type: 'circle',
                source: {
                    type: 'geojson',
                    data: this._createGeojsonPoint(geojsonData)
                },
                paint: {
                    'circle-radius': 10,
                    'circle-color': '#14db02'
                }
            });
        }

        map.getSource('start')
            .setData(geojsonData);
    }

    _mapChanged(map) {
        console.log("map", map);
        if (!map)
            return;

        map.on('click', (event) => {
            const coords = Object.keys(event.lngLat).map((key) => event.lngLat[key]);

            if (this.placementMode === 'start') {
                this._placeStartPoint(coords);
                this.start = coords;
            } else if (this.placementMode === 'end') {
                this._placeEndPoint(coords);
                this.end = coords;
            }

            if (this.start && this.end) {
                this.getRoute(this.start, this.end);
            }
        });
    }

    async getRoute(start, end) {
        const map = this._map;
        const query = await fetch(
            `https://api.mapbox.com/directions/v5/mapbox/cycling/${start[0]},${start[1]};${end[0]},${end[1]}?steps=true&geometries=geojson&access_token=${mapboxgl.accessToken}`,
            { method: 'GET' }
        );
        const json = await query.json();
        const data = json.routes[0];
        const route = data.geometry.coordinates;
        const geojson = {
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'LineString',
                coordinates: route
            }
        };
        if (map.getSource('route')) {
            map.getSource('route').setData(geojson);
        } else {
            map.addLayer({
                id: 'route',
                type: 'line',
                source: {
                    type: 'geojson',
                    data: geojson
                },
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round'
                },
                paint: {
                    'line-color': '#3887be',
                    'line-width': 5,
                    'line-opacity': 0.75
                }
            });
        }
    }

    static styles = [
        css`
            :host {
                display: block;
                position: absolute;
                top: 10px;
                left: 10px;
                z-index: 1;
            }

            .card {
                background: #fff;
                padding: 1rem;
                border-radius: 4px;
            }

            h2.card {

            }

            .directions {
                max-width: 33.3vw;
            }

            .height-1 {
                box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.24);
            }

            .height-2 {
                box-shadow: 0 3px 6px rgba(0,0,0,0.16), 0 3px 6px rgba(0,0,0,0.23);
            }

            button {
                margin-bottom: 0.4rem;
            }
        `
    ];

    render() {
        return html`
            <div class="card height-1 directions">
                <h2>Directions</h2>
                <p>First, press "Start" and select a place on the map. Next, press "End" and select a destination</p>
                <div>
                    <button
                        @click=${() => { this.placementMode = 'start'; }}
                    >
                        Start
                    </button>
                </div>
                <div>
                <button
                        @click=${() => { this.placementMode = 'end'; }}
                    >
                        End
                    </button>
                </div>
            </div>
        `;
    }
}
customElements.define('mapbox-navigation', MapboxNavigation);