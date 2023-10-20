import { ContextProvider } from "@lit/context";
import { LitElement, html, css } from "lit";
import { mapContext } from "./mapContext";
import mapboxgl from "mapbox-gl";
import './layer-widget.js';
import mapboxglStyles from './mapbox-gl.css.js';
import './mapbox-navigation.js';
import { bicycleFacilityRatingColor, roadwayPalette } from './colors.js';
import { baseStyles } from "./styles";
import './mwc-icon.js';

export class BikeMapApp extends LitElement {
    _mapProvider = new ContextProvider(this, { context: mapContext });

    static get properties() {
        return {};
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

            map.addSource('cycling-data', {
                type: 'geojson',
                data: 'https://data.bikemap.seanerice.dev/export.geojson'
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
        });
    }

    showMenu() {
        this._showMenu = true;
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

            .menu {
                display: block;
                position: absolute;
                left: -60vw;
                width: 60vw;
                height: 100%;
                z-index: 1;
                background: white;
                transition: all .5s ease;
            }

            .navbar {
                position: absolute;
                display: inline-block;
                top:0;
                left:0;
                right:0;
                background: beige;
                height: 5vh;
                z-index: 1;
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
                position: absolute;
                z-index: 1;
                left: 1vw;
                top: 1vh;
                transition: all .5s ease;
                background: white;
                border-radius: 3px;
            }

            #menu-checkbox:checked ~ label #menu-button, #menu-checkbox:checked ~ label #menu-cancel {
                left: 61vw;
            }

            #menu-checkbox:checked ~ .menu {
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

            .menu > h1 {
                margin-left: 1rem;
                margin-right: 1rem;
            }
        `
    ];

    render() {
        return html`
            <input type="checkbox" id="menu-checkbox">
            <label for="menu-checkbox">
                <mwc-icon id="menu-button" icon="menu" class="height-1"></mwc-icon>
                <mwc-icon id="menu-cancel" icon="close" class="height-1"></mwc-icon>
            </label>
            <div class="menu height-1">
                <h1>Charlotte Bike Map</h1>
                <div class="menu-item">
                    <layer-widget></layer-widget>
                </div>
                <hr>
                <div class="menu-item">
                    <mapbox-navigation></mapbox-navigation>
                </div>
            </div>
            <div id="map"></div>
        `;
    }
}

customElements.define('bikemap-app', BikeMapApp);