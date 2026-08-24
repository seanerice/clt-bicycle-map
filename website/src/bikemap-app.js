import { ContextProvider } from "@lit/context";
import { LitElement, html, css, nothing } from "lit";
import { mapContext } from "./mapContext";
import mapboxgl from "mapbox-gl";
import './layer-widget.js';
import mapboxglStyles from './mapbox-gl.css.js';
import './mapbox-navigation.js';
import { bicycleFacilityRatingColor, roadwayPalette } from './colors.js';
import { baseStyles } from "./styles";
import './mwc-icon.js';
import './location-search-menu.js';
import { CyclingDataSource, EMPTY_FEATURE_COLLECTION } from './cycling-data-source.js';

export class BikeMapApp extends LitElement {
    _mapProvider = new ContextProvider(this, { context: mapContext });

    // Mirrored from CyclingDataSource's onStateChange callback (story 3.8) —
    // see firstUpdated() below. Plain Lit reactive properties, no external
    // state-management dependency. Deliberately *not* given class-field
    // defaults here (unlike _mapProvider above): a `foo = false` class field
    // uses define-semantics and would shadow the reactive accessor Lit
    // installs on the prototype for properties declared below, silently
    // breaking reactivity. undefined is falsy, which is all render() needs.
    static get properties() {
        return {
            _showDirectionsWidget: { type: Boolean },
            _isLoadingFeatures: { type: Boolean },
            _hasFetchError: { type: Boolean },
            // Separate from _hasFetchError so dismissing the notice doesn't
            // require the underlying error to clear — it can reappear on a
            // subsequent failure even if an earlier one was dismissed.
            _errorDismissed: { type: Boolean }
        };
    }

    firstUpdated() {
        mapboxgl.accessToken = 'pk.eyJ1Ijoic2VhbmVyaWNlIiwiYSI6ImNsZ28zZjMwdjA4cHozam55NXg3ejFxNWQifQ.5Aic9Z6tQdSfC13zhLzatw';
        const map = new mapboxgl.Map({
            container: this.shadowRoot.getElementById('map'),
            style: 'mapbox://styles/seanerice/clnsc85cb00cf01p7d5jv2ham',
            center: [-80.8421784, 35.240988],
            zoom: 10
        });

        map.on('load', () => {
            this._mapProvider.setValue(map);

            map.addControl(new mapboxgl.NavigationControl());

            map.addSource('cycling-data', {
                type: 'geojson',
                data: EMPTY_FEATURE_COLLECTION
            });

            map.addLayer({
                'id': 'cycling-route-lines',
                'type': 'line',
                'source': 'cycling-data',
                'layout': {
                    'line-join': 'round',
                    'line-cap': 'round'
                },
                'filter': [
                    'all',
                    ['==', ['get', 'route'], 'bicycle'],
                    ['!=', ['get', 'state'], 'proposed']
                ],
                'paint': {
                    'line-color': [
                        'case',
                        ['==', ['get', 'cycle_network'], 'US:NC:Charlotte:Suggested Bike Route'],
                        '#8539C4',
                        [
                            'all',
                            ['==', ['get', 'cycle_network'], 'US:NC:Charlotte'],
                            ['has', 'ref']
                        ],
                        '#e6c627',
                        ['==', ['get', 'cycle_network'], 'US:NC:Mecklenburg'],
                        '#3964C4',
                        '#ababab'
                    ],
                    'line-width': [
                        'interpolate',
                        ['linear'],
                        ['zoom'],
                        12,
                        5,
                        22,
                        70
                    ],
                    'line-opacity': 0.6
                }
            });

            map.addLayer({
                'id': 'cycling-route-symbols',
                'type': 'symbol',
                'source': 'cycling-data',
                'layout': {
                    "symbol-placement": "line",
                    "text-font": ["Open Sans Regular"],
                    "text-field": [
                        'coalesce',
                        ['get', 'ref'],
                        ['get', 'name']
                    ],
                    "text-size": 16,
                },
                'filter': ['==', 'route', 'bicycle'],
                'paint': {}
            });

            map.addLayer({
                'id': 'cycling-paths',
                'type': 'line',
                'source': 'cycling-data',
                'layout': {
                    'line-join': 'round',
                    'line-cap': 'round'
                },
                'filter': [
                    'all',
                    ['has', 'bicycle'],
                    ['==', ['get', 'highwayType'], 'path']
                ],
                'paint': {
                    'line-color': [
                        'case',
                        ['==', ['get', 'bicycle'], 'yes'],
                        bicycleFacilityRatingColor.good,
                        ['==', ['get', 'bicycle'], 'designated'],
                        bicycleFacilityRatingColor.excellent,
                        'rgba(0, 0, 0, 0)'
                    ],
                    'line-width': 1.5,
                }
            });

            map.addLayer({
                'id': 'cycling-lanes-right',
                'type': 'line',
                'source': 'cycling-data',
                'layout': {},
                'filter': [
                    'all',
                    ['has', 'cyclewayRight'],
                    ['!=', ['get', 'cyclewayRight'], 'no']
                ],
                'paint': {
                    'line-color': [
                        'case',
                        ['==', ['get', 'cyclewayRight'], 'track'],
                        roadwayPalette.cycleTrack,
                        ['all',
                            ['==', ['get', 'cyclewayRight'], 'lane'],
                            ['has', 'cyclewayRightBuffer'],
                        ],
                        roadwayPalette.bufferedLane,
                        ['==', ['get', 'cyclewayRight'], 'lane'],
                        roadwayPalette.lane,
                        ['==', ['get', 'cyclewayRight'], 'share_busway'],
                        roadwayPalette.shareBusway,
                        ['==', ['get', 'cyclewayRight'], 'shared_lane'],
                        roadwayPalette.sharedLane,
                        ['==', ['get', 'cyclewayRight'], 'shoulder'],
                        roadwayPalette.shoulder,
                        roadwayPalette.none
                    ],
                    'line-width': [
                        'interpolate',
                        ['linear'],
                        ['zoom'],
                        10,
                        1,
                        17,
                        4
                    ],
                    'line-dasharray': [
                        'case',
                        ['==', ['get', 'cyclewayRight'], 'track'],
                        ['literal', [1]],
                        ['all',
                            ['==', ['get', 'cyclewayRight'], 'lane'],
                            ['has', 'cyclewayRightBuffer'],
                        ],
                        ['literal', [2, 2]],
                        ['==', ['get', 'cyclewayRight'], 'lane'],
                        ['literal', [2, 4]],
                        ['==', ['get', 'cyclewayRight'], 'shared_lane'],
                        ['literal', [2, 8]],
                        ['literal', []]
                    ],
                    'line-offset': [
                        'interpolate',
                        ['linear'],
                        ['zoom'],
                        12,
                        0,
                        22,
                        15
                    ]
                }
            });

            map.addLayer({
                'id': 'cycling-lanes-left',
                'type': 'line',
                'source': 'cycling-data',
                'layout': {},
                'filter': [
                    'all',
                    ['has', 'cyclewayLeft'],
                    ['!=', ['get', 'cyclewayLeft'], 'no']
                ],
                'paint': {
                    'line-color': [
                        'case',
                        ['==', ['get', 'cyclewayLeft'], 'track'],
                        roadwayPalette.cycleTrack,
                        ['all',
                            ['==', ['get', 'cyclewayLeft'], 'lane'],
                            ['has', 'cyclewayLeftBuffer'],
                        ],
                        roadwayPalette.bufferedLane,
                        ['==', ['get', 'cyclewayLeft'], 'lane'],
                        roadwayPalette.lane,
                        ['==', ['get', 'cyclewayLeft'], 'share_busway'],
                        roadwayPalette.shareBusway,
                        ['==', ['get', 'cyclewayLeft'], 'shared_lane'],
                        roadwayPalette.sharedLane,
                        ['==', ['get', 'cyclewayLeft'], 'shoulder'],
                        roadwayPalette.shoulder,
                        roadwayPalette.none
                    ],
                    'line-width': [
                        'interpolate',
                        ['linear'],
                        ['zoom'],
                        10,
                        1,
                        17,
                        4
                    ],
                    'line-dasharray': [
                        'case',
                        ['==', ['get', 'cyclewayLeft'], 'track'],
                        ['literal', [1]],
                        ['all',
                            ['==', ['get', 'cyclewayLeft'], 'lane'],
                            ['has', 'cyclewayLeftBuffer'],
                        ],
                        ['literal', [2, 2]],
                        ['==', ['get', 'cyclewayLeft'], 'lane'],
                        ['literal', [2, 4]],
                        ['==', ['get', 'cyclewayLeft'], 'shared_lane'],
                        ['literal', [2, 8]],
                        ['literal', []]
                    ],
                    'line-offset': [
                        'interpolate',
                        ['linear'],
                        ['zoom'],
                        12,
                        0,
                        22,
                        -15
                    ]
                }
            });

            this._cyclingDataSource = new CyclingDataSource(map, {
                onStateChange: ({ isLoadingFeatures, hasFetchError }) => {
                    this._isLoadingFeatures = isLoadingFeatures;
                    this._hasFetchError = hasFetchError;
                    // A fresh failure should re-surface the notice even if
                    // an earlier one was dismissed.
                    if (hasFetchError) {
                        this._errorDismissed = false;
                    }
                }
            });
            map.on('moveend', () => this._cyclingDataSource.scheduleFetch());
            this._cyclingDataSource.scheduleFetch(); // moveend doesn't fire for the initial view
        });
    }

    static styles = [
        baseStyles,
        mapboxglStyles,
        css`
            :host {
                display: block;
            }

            #map {
                width: 100%;
                height: 100dvh;
            }

            .hidden {
                display: none;
            }

            .menu-bar {
                display: block;
                position: absolute;
                left: -340px;
                width: 320px;
                height: 100%;
                z-index: 201;
                background: white;
                transition: all .5s ease;
            }

            #menu-checkbox {
                display: none;
            }

            label #menu-button, label #menu-cancel {
                --mdc-icon-size: 2rem;
                display: flex;
                justify-content: center;
                align-items: center;
                padding: 0.3rem;
                position: fixed;
                z-index: 201;
                left: 10px;
                top: 10px;
                transition: all .5s ease;
                background: white;
                border-radius: 3px;
            }

            #menu-checkbox:checked ~ label #menu-button, #menu-checkbox:checked ~ label #menu-cancel {
                left: 330px;
            }

            #menu-checkbox:checked ~ .menu-bar {
                left: 0;
            }

            #menu-checkbox:checked ~ label #menu-button {
                opacity: 0;
                visibility: hidden;
            }

            label #menu-cancel {
                opacity: 0;
                visibility: hidden;
            }

            #menu-checkbox:checked ~ label #menu-cancel {
                opacity: 1;
                visibility: visible;
            }

            .menu-item {
                margin: 0 1rem;
            }

            .menu-header {
                display: inline-block;
                background: lightgray;
                width: 100%;
            }

            .menu-header > h1 {
                margin-left: 1rem;
                margin-right: 1rem;
                font-size: 1.5em;
            }

            #directions-button {
                --mdc-icon-size: 2rem;
                display: flex;
                justify-content: center;
                align-items: center;
                padding: 0.3rem;
                position: absolute;
                z-index: 100;
                left: 10px;
                top: 60px;
                transition: all .5s ease;
                background: white;
                border: none;
                border-radius: 3px;
                border-color: none;
            }

            .menu-scrim {
                display: none;
                position: fixed;
                left: 0;
                right: 0;
                top: 0;
                bottom: 0;
                z-index: 200;
            }

            #menu-checkbox:checked ~ .menu-scrim {
                display: block;
                background: rgba(0, 0, 0, 0.5);
            }

            .loading-bar {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                height: 3px;
                z-index: 300;
                background: linear-gradient(90deg, transparent, #3964C4, transparent);
                background-size: 200% 100%;
                animation: loading-bar-sweep 1.2s ease-in-out infinite;
            }

            @keyframes loading-bar-sweep {
                0% { background-position: 200% 0; }
                100% { background-position: -200% 0; }
            }

            .fetch-error-notice {
                display: flex;
                align-items: center;
                gap: 0.5rem;
                position: fixed;
                bottom: 20px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 300;
                max-width: calc(100% - 40px);
                padding: 0.5rem 0.5rem 0.5rem 1rem;
                background: white;
                border-radius: 3px;
            }

            .fetch-error-notice mwc-icon {
                --mdc-icon-size: 1.2rem;
            }
        `
    ];

    _handleDirectionsButtonClick() {
        this.shadowRoot.getElementById('navigation').show();
    }

    _handleLocationSelected(event) {
        const { coord, displayText } = event.detail;
        this.shadowRoot.getElementById('navigation')._setCoord(coord, displayText);
    }

    _handleLocationInputFocused(event) {
        this.shadowRoot.getElementById('location-search-menu').show();
    }

    _handleDismissError() {
        this._errorDismissed = true;
    }

    render() {
        return html`
            ${this._isLoadingFeatures
                ? html`<div class="loading-bar" role="status" aria-label="Loading map data"></div>`
                : nothing}

            ${this._hasFetchError && !this._errorDismissed
                ? html`
                    <div class="fetch-error-notice height-2" role="alert">
                        <span>Couldn't refresh map data — showing last known view</span>
                        <button
                            class="nostyle"
                            aria-label="Dismiss"
                            @click=${this._handleDismissError}
                        >
                            <mwc-icon icon="close"></mwc-icon>
                        </button>
                    </div>
                `
                : nothing}

            <input type="checkbox" id="menu-checkbox">
            <label for="menu-checkbox">
                <mwc-icon id="menu-button" icon="menu" class="height-1"></mwc-icon>
                <mwc-icon id="menu-cancel" icon="close" class="height-1"></mwc-icon>
            </label>
            <button
                id="directions-button"
                class="height-1"
                @click=${this._handleDirectionsButtonClick}
            >
                <mwc-icon icon="directions"></mwc-icon>
            </button>

            <mapbox-navigation id="navigation"
                @location-input-focused=${this._handleLocationInputFocused}
            ></mapbox-navigation>

            <div class="menu-scrim"></div>
            <div class="menu-bar height-1">
                <div class="menu">
                    <div class="menu-header">
                        <h1>Charlotte Bike Map</h1>
                    </div>
                    <div class="menu-item">
                        <layer-widget></layer-widget>
                    </div>    
                </div>
            </div>

            <location-search-menu
                id="location-search-menu"
                @location-selected=${this._handleLocationSelected}
            ></location-search-menu>

            <div id="map"></div>
        `;
    }
}

customElements.define('bikemap-app', BikeMapApp);