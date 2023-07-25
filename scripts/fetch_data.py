import json
import requests

url = 'http://overpass-api.de/api/interpreter'  # Overpass API URL
query = f"""
    [out:json][timeout:25];
    area(id:3600177415)->.searchArea;
    (
        // query part for "cycleway:*=*"
        way[~"^cycleway:.*$"~"."](area.searchArea);
        way["highway"="cycleway"](area.searcharea);

        // query part for "route=bicycle"
        relation["route"="bicycle"](area.searchArea);
    );

    out body;
    >;
    out skel qt;
"""
r = requests.get(url, params={'data': query})
data = r.json()

with open("./test.geo.json",mode="w") as f:
  f.write(json.dumps(data, indent=4))