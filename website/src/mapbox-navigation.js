
import { ContextConsumer } from '@lit/context';
import { LitElement, html, css, nothing } from 'lit';
import { mapContext } from './mapContext';
import mapboxgl from 'mapbox-gl';
import { baseStyles } from './styles';
import './mwc-icon.js';

export class MapboxNavigation extends LitElement {
    _mapConsumer = new ContextConsumer(
        this,
        {
            context: mapContext,
            subscribe: true
        }
    );

    constructor() {
        super();

        this.coords = [null, null];
        this.coordsDisplayText = [null, null];
    }

    static get properties() {
        return {
            interactionState: { type: String },
            coords: { type: Array },
            coordsDisplayText: { type: String },
        };
    }

    get _map() {
        return this._mapConsumer.value;
    }

    _inputFocusHandler(focusedIndex) {
        return () => {
            this._focusedIndex = focusedIndex;
            this.dispatchEvent(
                new CustomEvent('location-input-focused', {
                    bubbles: true
                })
            )
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

    _addIntermediatePoint(index, coord) {
        if (index === 0 || this.coords.length - 1) {
            throw new Error("Cannot add intermediate point to start or end of array");
        }

        this.coords.splice(index, 0, coord);
    }

    _removeIntermediatePoint(index) {
        if (index === 0 || this.coords.length - 1) {
            throw new Error("Cannot remove intermediate point to start or end of array");
        }

        this.coords.splice(index, 1);
    }

    _updateMapPoints(...coords) {
        const start = coords[0];
        const end = coords[coords.length - 1];
        const intermediatePoints = coords.slice(1, -1);
        const map = this._map;

        if (start) {
            const geojsonData = this._createGeojsonPoint(start);
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

        if (end) {
            const geojsonData = this._createGeojsonPoint(end);
    
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

        for (const coord of intermediatePoints) {
            // todo: implement intermediate points
            throw new Error("Not implemented");
        }
    }

    _setCoord(coord, displayText) {
        this.coords[this._focusedIndex] = coord;
        this.coords = [...this.coords];

        this._updateMapPoints(...this.coords);

        if (this.coords.every(coord => !!coord)) {
            this.getRoute(...this.coords);
        }

        if (!displayText)
            return;

        this.coordsDisplayText[this._focusedIndex] = displayText;
        this.coordsDisplayText = [...this.coordsDisplayText];
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

            #input-container {
                display: grid;
                grid-template-columns: 1fr 5fr 1fr;
                align-items: center;
                grid-row-gap: 1rem;
            }

            #input-container > * {
                justify-self: center;
            }

            #input-container > input {
                width: 100%;
                height: 3rem;
            }
        `
    ];

    _getIntermediatePointsTemplate() {
        const intermediatePointInputs = [];
        if (this.coords.length <= 2)
            return nothing;

        for (let i = 1; i < this.coords.length - 2; i += 1) {
            intermediatePointInputs.push(html`
                <mwc-icon icon="trip_origin"></mwc-icon>
                <input
                    type="text"
                    placeholder=${`Intermediate Point ${i}`}
                    value=${`${this.coords[i] || ""}`}
                    @focus=${this._inputFocusHandler(i)}
                    inputmode="none"
                >
                <span></span>
            `);
        }

        return intermediatePointInputs;
    }

    render() {
        if (!this._map)
            return nothing;

        return html`
            <div id="input-container">
                <mwc-icon icon="trip_origin"></mwc-icon>
                <input
                    type="text"
                    placeholder="Starting point"
                    value=${`${this.coordsDisplayText[0] || this.coords[0] || ""}`}
                    @focus=${this._inputFocusHandler(0)}
                    inputmode="none"
                >
                <span></span>
                    
                ${this._getIntermediatePointsTemplate()}
                <mwc-icon icon="sports_score"></mwc-icon>
                <input
                    type="text"
                    placeholder="Destination"
                    value=${`${this.coordsDisplayText[this.coordsDisplayText.length - 1] || this.coords[this.coords.length - 1] || ""}`}
                    @focus=${this._inputFocusHandler(this.coords.length - 1)}
                    inputmode="none"
                >
                <span></span>
            </div>
        `;
    }
}
customElements.define('mapbox-navigation', MapboxNavigation);