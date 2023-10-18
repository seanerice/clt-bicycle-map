import { ContextProvider } from "@lit/context";
import { LitElement, html, css } from "lit";
import { mapContext } from "./mapContext";
import mapboxgl from "mapbox-gl";
import './layer-widget.js';
import mapboxglStyles from './mapbox-gl.css.js';
import './mapbox-navigation.js';

const roadwayPalette = {
    cycleTrack: '#2C9E30',
    bufferedLane: '#8EC210',
    lane: '#FF8E15',
    shareBusway: '#FF8E15',
    sharedLane: '#FF8E15',
    none: '#FF0D0D'
};

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
                    '#0DDD37',
                    ['==', ['get', 'bicycle'], 'designated'],
                    '#2747c4',
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
                            ['has', 'cyclewayRightBuffer' ],
                        ],
                        roadwayPalette.bufferedLane,
                        ['==', ['get', 'cyclewayRight'], 'lane'],
                        roadwayPalette.lane,
                        ['==', ['get', 'cyclewayRight'], 'share_busway'],
                        roadwayPalette.shareBusway,
                        ['==', ['get', 'cyclewayRight'], 'shared_lane'],
                        roadwayPalette.sharedLane,
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
                            ['has', 'cyclewayRightBuffer' ],
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
                        ['has', 'cyclewayLeftBuffer' ],
                    ],
                    roadwayPalette.bufferedLane,
                    ['==', ['get', 'cyclewayLeft'], 'lane'],
                    roadwayPalette.lane,
                    ['==', ['get', 'cyclewayLeft'], 'share_busway'],
                    roadwayPalette.shareBusway,
                    ['==', ['get', 'cyclewayLeft'], 'shared_lane'],
                    roadwayPalette.sharedLane,
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
                        ['has', 'cyclewayLeftBuffer' ],
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

    static styles = [
        mapboxglStyles,
        css`
            :host {
                display: block;
            }
        `
    ];

    render() {
        return html`
            <layer-widget></layer-widget>
            <mapbox-navigation></mapbox-navigation>
            <div id='map' style='width: 100%; height: 97vh;'></div>
        `;
    }
}

customElements.define('bikemap-app', BikeMapApp);