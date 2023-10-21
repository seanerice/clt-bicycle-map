
import { LitElement, html, css, nothing } from 'lit';
import { ContextConsumer } from '@lit/context';
import { mapContext } from './mapContext';
import mapboxgl from 'mapbox-gl';
import { baseStyles } from './styles';
import './mwc-icon.js';
import { classMap } from 'lit-html/directives/class-map.js';

export class MapboxNavigation extends LitElement {
    _mapConsumer = new ContextConsumer(
        this,
        {
            context: mapContext,
            subscribe: true,
            callback: (v) => this._mapChanged(v)
        }
    );

    constructor() {
        super();

        this.coords = [null, null];
    }

    static get properties() {
        return {
            interactionState: { type: String },
            _showChooseLocationWidget: { type: Boolean }

        };
    }

    get _map() {
        return this._mapConsumer.value;
    }

    _menuClickHandler(menuItemType) {
        return (event) => {
            this._placePointMode = false;

            switch (menuItemType) {
                case 'my-location':
                    navigator.geolocation.getCurrentPosition(
                        (pos) => {
                            const coord = [
                                pos.coords.longitude,
                                pos.coords.latitude
                            ];
                            this._map.flyTo({
                                center: coord,
                                zoom: 15,
                                duration: 2000,
                                essential: true
                            });
                            this._setCoord(coord);
                        },
                        (err) => {
                            console.error(err);
                        }
                    );
                    this._showChooseLocationWidget = false;
                    break;
                case 'select-location-on-map':
                    this._placePointMode = true;
                    this._showChooseLocationWidget = false;
                    break;
                default:
                    break;
            }
        }
    }

    _inputFocusHandler(focusedIndex) {
        return (event) => {
            this._focusedIndex = focusedIndex;
            this._showChooseLocationWidget = true;
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

    _setCoord(coord) {
        this.coords[this._focusedIndex] = coord;
        this.coords = [...this.coords];

        this._updateMapPoints(...this.coords);

        if (this.coords.every(coord => !!coord)) {
            this.getRoute(...this.coords);
        }
    }

    _mapChanged(map) {
        if (!map)
            return;

        map.on('click', (event) => {
            if (this._placePointMode) {
                const coords = Object.keys(event.lngLat)
                    .map((key) => event.lngLat[key]);
                
                this._setCoord(coords);
                this._placePointMode = false;
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

            .menu-item {
                display: block;
                padding: 1rem;
            }

            .menu-item > * {
                display: inline-block;
                vertical-align: middle;
            }

            .menu-item > mwc-icon {
                margin-right: 1rem;                
            }

            .menu-item:hover {
                background-color: lightgray;
            }

            #choose-location-widget {
                display:none;
                position: fixed;
                top: 0;
                bottom: 0;
                left: 0;
                right: 0;
                background-color: white;
                z-index: 201;
            }

            #choose-location-widget.visible {
                display: block;
            }

            #input-container {
                display: grid;
                grid-template-columns: 1fr 3fr 1fr;
            }

            #input-container > * {
                grid-column: 2 / span 1;
                justify-self: center;
            }

            #input-container > * > input {
                width: 100%;
                height: 3rem;
                margin-top: 1rem;
            }
        `
    ];

    _getIntermediatePointsTemplate() {
        const intermediatePointInputs = [];
        if (this.coords.length <= 2)
            return nothing;

        for (let i = 1; i < this.coords.length - 2; i += 1) {
            intermediatePointInputs.push(html`
                <input
                    type="text"
                    placeholder=${`Intermediate Point ${i}`}
                    value=${`${this.coords[i] || ""}`}
                    @focus=${this._inputFocusHandler(i)}
                    inputmode="none"
                >
            `);
        }

        return intermediatePointInputs;
    }

    render() {
        if (!this._map)
            return nothing;

        return html`
                <!-- <h3>Directions</h3> -->
                <!-- <p>Get cycling directions in Charlotte.</p> -->
                <div id="input-container">
                    <div>
                        <input
                            type="text"
                            placeholder="Starting point"
                            value=${`${this.coords[0] || ""}`}
                            @focus=${this._inputFocusHandler(0)}
                            inputmode="none"
                            >
                    </div>
                    ${this._getIntermediatePointsTemplate()}
                    <div>
                        <input
                            type="text"
                            placeholder="Destination"
                            value=${`${this.coords[this.coords.length - 1] || ""}`}
                            @focus=${this._inputFocusHandler(this.coords.length - 1)}
                            inputmode="none"
                            >
                    </div>
                </div>
                
                <div id="choose-location-widget" class=${classMap({ visible: this._showChooseLocationWidget })}>
                    <a class="menu-item" @click=${this._menuClickHandler('my-location')}>
                        <mwc-icon icon="my_location"></mwc-icon>
                        My Location
                    </a>
                    <a class="menu-item" @click=${this._menuClickHandler('select-location-on-map')}>
                        <mwc-icon icon="location_on"></mwc-icon>
                        Choose on the Map
                    </a>
                </div>
        `;
    }
}
customElements.define('mapbox-navigation', MapboxNavigation);