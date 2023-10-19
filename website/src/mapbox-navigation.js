
import { LitElement, html, css, nothing } from 'lit';
import { ContextConsumer } from '@lit/context';
import { mapContext } from './mapContext';
import mapboxgl from 'mapbox-gl';
import { baseStyles } from './styles';

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
            interactionState: { type: String },
        };
    }

    get _map() {
        return this._mapConsumer.value;
    }

    _setStateHandler(interactionState) {
        return (event) => {
            this.interactionState = interactionState;
        }
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
            const coords = Object.keys(event.lngLat)
                .map((key) => event.lngLat[key]);

            switch(this.interactionState) {
                case 'place-start':
                    this._placeStartPoint(coords);
                    this.start = coords;
                    this.interactionState = 'select';
                    if (this.start && this.end) {
                        this.getRoute(this.start, this.end);
                    }
                    break;
                case 'place-end':
                    this._placeEndPoint(coords);
                    this.end = coords;
                    this.interactionState = 'select';
                    if (this.start && this.end) {
                        this.getRoute(this.start, this.end);
                    }
                    break;
                case 'select':
                default:
                    break;
            }
        });
    }

    async getRoute(...coords) {
        const map = this._map;
        const coordUrlParam = coords.map(coord => `${coord[0]},${coord[1]}`)
            .join(';');
        const directionsApiUrl = new URL(`https://api.mapbox.com/directions/v5/mapbox/cycling/${coordUrlParam}`);
        directionsApiUrl.searchParams.set('steps', 'true');
        directionsApiUrl.searchParams.set('overview', 'full');
        directionsApiUrl.searchParams.set('geometries', 'geojson');
        directionsApiUrl.searchParams.set('access_token', mapboxgl.accessToken);
        directionsApiUrl.searchParams.set('alternatives', 'true');
        const query = await fetch(
            directionsApiUrl,
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
        baseStyles,
        css`
            :host {
                display: block;
            }

            button {
                margin-bottom: 0.4rem;
            }
        `
    ];

    render() {
        if (!this._map)
            return nothing;

        return html`
            <div>
                <h3>Directions</h3>
                <p>Get cycling directions in Charlotte.</p>
                <input
                    type="text"
                    placeholder="Starting point"
                    value=${`${this?.start?.map((a) => a.toFixed(6)).join(', ') || ""}`}
                    @focus=${this._setStateHandler('place-start')}
                    >
                <input
                    type="text"
                    placeholder="Destination"
                    value=${`${this?.end?.map((a) => a.toFixed(6)).join(', ') || ""}`}
                    @focus=${this._setStateHandler('place-end')}
                    >
                </div>
            </div>
        `;
    }
}
customElements.define('mapbox-navigation', MapboxNavigation);