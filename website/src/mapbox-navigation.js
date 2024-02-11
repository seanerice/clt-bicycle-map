
import { ContextConsumer } from '@lit/context';
import { LitElement, html, css, nothing } from 'lit';
import { mapContext } from './mapContext';
import mapboxgl from 'mapbox-gl';
import { baseStyles } from './styles';
import { classMap } from 'lit/directives/class-map.js';
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
            visible: { type: Boolean }
        };
    }

    show() {
        this.visible = true;
        this.dispatchEvent(
            new CustomEvent('visible-change', {
                bubbles: true,
                detail: { value: this.visible }
            })
        );
    }

    hide() {
        this.visible = false;
        this.dispatchEvent(
            new CustomEvent('visible-change', {
                bubbles: true,
                detail: { value: this.visible }
            })
        );
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

    _fitScreenToPoints(coords) {
        const max = [null, null];
        const min = [null, null];
        for (const [a, b] of coords) {
            if (!max[0] || a > max[0]) {
                max[0] = a;
            }
            if (!min[0] || a < min[0]) {
                min[0] = a;
            }
            if (!max[1] || b > max[1]) {
                max[1] = b;
            }
            if (!min[1] || b < min[1]) {
                min[1] = b;
            }
        }

        const h = document.documentElement.clientHeight;
        this._map.fitBounds([min, max], {
            padding: { top: h * 0.05, bottom: h * 0.45, left: h * 0.05, right: h * 0.05 },
            duration: 2000
        });
    }

    _setCoord(coord, displayText) {
        if (this._focusedIndex === null || this._focusedIndex === undefined)
            this._focusedIndex = this.coords.length - 1;

        if (!this.visible)
            this.show();

        this.coords[this._focusedIndex] = coord;
        this.coords = [...this.coords];

        this._updateMapPoints(...this.coords);

        if (this.coords.every(coord => !!coord)) {
            this.getRoute(...this.coords).then(data => {
                const routePoints = data.geometry.coordinates;
                this._fitScreenToPoints(routePoints);
            });
        } else {
            this._map.flyTo({
                center: coord,
                zoom: 15,
                duration: 2000,
                essential: true
            });
        }

        if (!displayText)
            return;

        this.coordsDisplayText[this._focusedIndex] = displayText;
        this.coordsDisplayText = [...this.coordsDisplayText];

        this._focusedIndex = null;
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

        return data;
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

            #navigation-widget {
                position: fixed;
                bottom: -40vh;
                left: 0;
                right: 0;
                max-height: 40vh;
                height: 40vh;
                z-index: 100;
                background: white;
                transition: all .5s ease;
                display: flex;
                flex-direction: column;
            }

            #navigation-widget.visible {
                bottom: 0;
            }

            #close-nav-button {
                display: flex;
                align-self: flex-end;
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
            <div id="navigation-widget" class=${classMap({ visible: this.visible })}>
                <button
                    id="close-nav-button"
                    class="nostyle"
                    @click=${() => { this.hide(); }}
                >
                    <mwc-icon icon="close"></mwc-icon>
                </button>
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
            </div>

        `;
    }
}
customElements.define('mapbox-navigation', MapboxNavigation);