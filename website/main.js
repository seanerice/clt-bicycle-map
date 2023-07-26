window.addEventListener('load', () => {
  mapboxgl.accessToken = 'pk.eyJ1Ijoic2VhbmVyaWNlIiwiYSI6ImNsZ28zZjMwdjA4cHozam55NXg3ejFxNWQifQ.5Aic9Z6tQdSfC13zhLzatw';
  var map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/streets-v11',
    center: [-80.8421784, 35.240988],
    zoom: 10
  });
  
  map.on('load', () => {
  
    map.addSource('cycling-data', {
      type: 'geojson',
      data: 'https://raw.githubusercontent.com/seanerice/clt-bicycle-map/main/data/export.geojson'
    });
        
        map.addLayer({
      'id': 'cycling-route-lines',
      'type': 'line',
      'source': 'cycling-data',
      'layout': {
        'line-join': 'round',
        'line-cap': 'round'
      },
      'filter': ['all',
                ['==', ['get', 'route'], 'bicycle'],
                ['!=', ['get', 'state'], 'proposed']],
      'paint': {
        'line-color': ['case',
                    ['==', ['get', 'cycle_network'], 'US:NC:Charlotte:Suggested Bike Route'],
                    '#8539C4',
                    ['all',
                        ['==', ['get', 'cycle_network'], 'US:NC:Charlotte'],
                        ['has', 'ref']
                    ],
                    '#3964C4',
                    '#3964C4'
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
        'any',
        ['==', ['get', 'highway'], 'cycleway'],
                
      ],
      'paint': {
        'line-color': '#2747c4',
        'line-width': 1.5,
      }
    });
  
    map.addLayer({
      'id': 'cycling-footpaths',
      'type': 'line',
      'source': 'cycling-data',
      'layout': {
        'line-join': 'round',
        'line-cap': 'round'
      },
      'filter': [
        'any',
        ['==', ['get', 'highway'], 'path'],
        [
          'all',
          ['==', ['get', 'highway'], 'footway'],
                    ['any',
                        ['==', ['get', 'bicycle'], 'yes'],
                        ['==', ['get', 'bicycle'], 'designated']
                    ]
        ],
  
      ],
      'paint': {
        'line-color': '#027d62',
        'line-width': 1.5,
      }
    });
  
    map.addLayer({
      'id': 'cycling-lanes-right',
      'type': 'line',
      'source': 'cycling-data',
      'layout': {},
      'filter': ['all',
        ['!=', ['get', 'highway'], 'cycleway'],
        ['any',
          ['has', 'cycleway:right'],
          ['has', 'cycleway:both'],
          ['has', 'cycleway']
        ]
      ],
      'paint': {
        'line-color': '#2747c4',
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
          'let', 'cyclewayValue', ['coalesce',
            ['get', 'cycleway:right'],
            ['get', 'cycleway:both'],
            ['get', 'cycleway']
          ],
          'cyclewayBufferValue', ['coalesce',
            ['get', 'cycleway:right:buffer'],
            ['get', 'cycleway:both:buffer'],
            ['get', 'cycleway:buffer']
          ],
          ['case',
            ['==', ['var', 'cyclewayValue'], 'track'],
            ['literal', [1]],
            ['all',
              ['==', ['var', 'cyclewayValue'], 'lane'],
              ['any',
                ['==', ['var', 'cyclewayBufferValue'], 'yes'],
                ['>', ['number', ['var', 'cyclewayBufferValue'], 0], 0]
              ],
            ],
            ['literal', [2, 2]],
            ['==', ['var', 'cyclewayValue'], 'lane'],
            ['literal', [2, 4]],
            ['==', ['var', 'cyclewayValue'], 'shared_lane'],
            ['literal', [2, 8]],
            ['literal', []]
          ]
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
                ['!=', ['get', 'highway'], 'cycleway'],
                ['any',
                    ['has', 'cycleway:left'],
                    ['has', 'cycleway:both'],
                    ['has', 'cycleway'],
                ]
            ],
      'paint': {
        'line-color': '#2747c4',
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
          'let', 'cyclewayValue', ['coalesce',
            ['get', 'cycleway:left'],
            ['get', 'cycleway:both'],
            ['get', 'cycleway']
          ],
          'cyclewayBufferValue', ['coalesce',
            ['get', 'cycleway:left:buffer'],
            ['get', 'cycleway:both:buffer'],
            ['get', 'cycleway:buffer']
          ],
          ['case',
            ['==', ['var', 'cyclewayValue'], 'track'],
            ['literal', [1]],
            ['all',
              ['==', ['var', 'cyclewayValue'], 'lane'],
              ['any',
                ['==', ['var', 'cyclewayBufferValue'], 'yes'],
                ['>', ['number', ['var', 'cyclewayBufferValue'], 0], 0]
              ],
            ],
            ['literal', [2, 2]],
            ['==', ['var', 'cyclewayValue'], 'lane'],
            ['literal', [2, 4]],
            ['==', ['var', 'cyclewayValue'], 'shared_lane'],
            ['literal', [2, 8]],
            ['literal', []]
          ]
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
});

