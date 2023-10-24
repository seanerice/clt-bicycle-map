
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
        this.coordsDisplayText = [null, null];
    }

    static get properties() {
        return {
            interactionState: { type: String },
            coords: { type: Array },
            coordsDisplayText: { type: String },
            _showChooseLocationWidget: { type: Boolean },
            _searchResults: { type: Array },
            _locationSearchTerm: { type: String }
        };
    }

    get _map() {
        return this._mapConsumer.value;
    }

    _menuClickHandler(menuItemType, options) {
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
                            // todo: add reverse geocoding to get address
                            this.geocodingSearch(...coord).then(res => {
                                const displayText = res.features[0].place_name;
                                this._setCoord(coord, displayText);
                            });
                            this._setCoord(coord);
                        },
                        (err) => {
                            console.error(err);
                        }
                    );
                    this._showChooseLocationWidget = false;
                    this._searchResults = null;
                    this._locationSearchTerm = '';
                    break;
                case 'select-location-on-map':
                    this._placePointMode = true;
                    this._showChooseLocationWidget = false;
                    this._searchResults = null;
                    this._locationSearchTerm = '';
                    break;
                case 'searched-location':
                    this._setCoord(options.searchResult.center, options.searchResult.place_name);
                    this._showChooseLocationWidget = false;
                    this._searchResults = null;
                    this._locationSearchTerm = '';
                default:
                    break;
            }
        }
    }

    _inputFocusHandler(focusedIndex) {
        return () => {
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

    _mapChanged(map) {
        if (!map)
            return;

        map.on('click', (event) => {
            if (this._placePointMode) {
                const coord = Object.keys(event.lngLat)
                    .map((key) => event.lngLat[key]);
                
                // todo: add reverse geocoding to get address
                this.geocodingSearch(...coord).then(res => {
                    const displayText = res.features[0].place_name;
                    this._setCoord(coord, displayText);
                });
                this._setCoord(coord);
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

    async geocodingSearch(...args) {
        if (args.length === 0 || args.length > 2) {
            throw new Error("args array may only have length of 1 or 2.");
        }

        let geocodingApiUrl;

        if (args.length === 1) {
            geocodingApiUrl = new URL(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(args[0])}.json`);
        }

        if (args.length === 2 && args.every(arg => Number(arg))) {
            geocodingApiUrl = new URL(`https://api.mapbox.com/geocoding/v5/mapbox.places/${args.map(arg => Number(arg)).join(',')}.json`);
        }
        
        geocodingApiUrl.searchParams.set('access_token', mapboxgl.accessToken);
        geocodingApiUrl.searchParams.set('types','place,neighborhood,address,poi');
        geocodingApiUrl.searchParams.set('bbox', '-81.06355,35.00332,-80.52998,35.41154');
        const res = await fetch(
            geocodingApiUrl,
            { method: 'get' }
        );
        const data = await res.json();
        return data;
    }

    async searchForLocation() {
        const locationSearchInput = this.shadowRoot.getElementById('location-search-input');
        const search = locationSearchInput.value;
        this._locationSearchTerm = search;
        const data = await this.geocodingSearch(search);
        this._searchResults = data.features;
    }

    async _handleLocationSearchButton() {
        await this.searchForLocation();
    }

    async _handleLocationSearchKeyDown(event) {
        if (event.keyCode === 13) {
            await this.searchForLocation();
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
                position: fixed;
                height: 100vh;
                height: 100dvh;
                bottom: -100vh;
                bottom: -100dvh;
                left: 0;
                right: 0;
                background-color: white;
                z-index: 201;
                transition: all .5s ease;
                display: flex;
                flex-direction: column;
                align-items: stretch;
            }

            #choose-location-widget.visible {
                bottom: 0;
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

            .search-bar {
                height: 3rem;
                position: relative;
            }

            .search-bar input {
                background-color: white;
                border-radius: 1rem;
                height: 100%;
                width: 100%;
                box-sizing: border-box;
                position: relative;
                padding-left: 1rem;
                padding-right: 3rem;
                outline: 0;
                text-overflow: ellipsis;
            }

            .search-bar button {
                height: 100%;
                right: 2rem;
                position: absolute;
                top: 0;
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

    _searchResultsTemplate() {
        if (!this._searchResults) {
            return nothing;
        }

        if (this._searchResults.length <= 0) {
            return html`
                <p class="menu-item">No Results</p>`;
        }

        return this._searchResults.map(searchResult => {
            return html`
                <a class="menu-item" @click=${this._menuClickHandler('searched-location', { searchResult })}>
                    <mwc-icon icon="location_on"></mwc-icon>
                    ${searchResult.text}
                    ${searchResult.place_name}
                </a>
            `;
        });
    }

    render() {
        if (!this._map)
            return nothing;

        return html`
                <!-- <h3>Directions</h3> -->
                <!-- <p>Get cycling directions in Charlotte.</p> -->
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
                
                <!-- todo: refactor this into its own component -->
                <div id="choose-location-widget" class=${classMap({ visible: this._showChooseLocationWidget })}>
                    <div class="search-bar menu-item">
                        <input
                            id="location-search-input"
                            type="text"
                            placeholder="Search..."
                            .value=${this._locationSearchTerm || ''}
                            @keydown=${this._handleLocationSearchKeyDown}>
                        <button class="nostyle" @click=${this._handleLocationSearchButton}><mwc-icon icon="search"></mwc-icon></button>
                    </div>
                    ${this._searchResultsTemplate()}
                    ${this._searchResults ? html`<hr>` : nothing}
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