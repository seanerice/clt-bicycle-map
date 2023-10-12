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
      'filter': ['has', 'bicycle'],
      'paint': {
        'line-color': [
          'case',
          ['==', ['get', 'bicycle'], 'yes'],
          '#0DDD37',
          ['==', ['get', 'bicycle'], 'designated'],
          '#2747c4',
          '#2747c4'
        ],
        'line-width': 1.5,
      }
    });
  
    // map.addLayer({
    //   'id': 'cycling-footpaths',
    //   'type': 'line',
    //   'source': 'cycling-data',
    //   'layout': {
    //     'line-join': 'round',
    //     'line-cap': 'round'
    //   },
    //   'filter': [
    //     'any',
    //     ['==', ['get', 'highway'], 'path'],
    //     [
    //       'all',
    //       ['==', ['get', 'highway'], 'footway'],
    //                 ['any',
    //                     ['==', ['get', 'bicycle'], 'yes'],
    //                     ['==', ['get', 'bicycle'], 'designated']
    //                 ]
    //     ],
  
    //   ],
    //   'paint': {
    //     'line-color': '#027d62',
    //     'line-width': 1.5,
    //   }
    // });
  
    map.addLayer({
      'id': 'cycling-lanes-right',
      'type': 'line',
      'source': 'cycling-data',
      'layout': {},
      'filter': ['has', 'cyclewayRight'],
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
          'case',
          ['==', ['get', 'cyclewayRight'], 'track'],
          ['literal', [1]],
          ['all',
            ['==', ['get', 'cyclewayRight'], 'lane'],
            // ['any',
            //   ['==', ['get', 'cyclewayBufferValue'], 'yes'],
            //   ['>', ['number', ['get', 'cyclewayBufferValue'], 0], 0]
            // ],
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
      'filter': ['has', 'cyclewayLeft'],
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
          'case',
          ['==', ['get', 'cyclewayLeft'], 'track'],
          ['literal', [1]],
          ['all',
            ['==', ['get', 'cyclewayLeft'], 'lane'],
            // ['any',
            //   ['==', ['get', 'cyclewayBufferValue'], 'yes'],
            //   ['>', ['number', ['get', 'cyclewayBufferValue'], 0], 0]
            // ],
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
});

