"""Fetches gas stations (amenity=fuel) from OpenStreetMap via Overpass and
writes data/gas_stations.geojson. Represented as points — nodes use their own
lat/lon, ways/relations (larger station complexes, drawn as building outlines
in OSM) use Overpass's `out center` centroid, matching the doc's plan of
simple circle markers rather than full polygons.
"""

import json
import os
import sys
from pathlib import Path

import requests

OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter"
OUTPUT_PATH = Path(__file__).parent.parent / "public" / "data" / "gas_stations.geojson"

# Overpass's server (or a fronting proxy) 406s requests.post's default
# "python-requests/x.x.x" User-Agent — a custom one clears it.
HEADERS = {"User-Agent": "ev-siting-map-fetch-script/1.0"}

# Filtered against Ontario's real administrative boundary, NOT bbox.py's
# rectangular bbox — that box is deliberately padded generous at the edges
# (see bbox.py), and at Ontario's scale a padded rectangle covers large
# chunks of Quebec, Manitoba, and the US (Michigan/Ohio/New York). A plain
# [bbox:...] filter would pull in gas stations from all of those. This one
# query (first attempt, no bbox pre-filter needed) came back with exactly the
# expected count for real Ontario coverage.
QUERY = """
[out:json][timeout:120];
area["ISO3166-2"="CA-ON"]->.on;
nwr[amenity=fuel](area.on);
out center;
"""


def element_to_point_feature(el: dict) -> dict | None:
    if el["type"] == "node":
        lon, lat = el["lon"], el["lat"]
    else:
        center = el.get("center")
        if not center:
            return None
        lon, lat = center["lon"], center["lat"]

    tags = el.get("tags", {})
    return {
        "type": "Feature",
        "properties": {
            "id": el["id"],
            "name": tags.get("name"),
            "brand": tags.get("brand"),
            "opening_hours": tags.get("opening_hours"),
        },
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
    }


def main() -> None:
    response = requests.post(OVERPASS_ENDPOINT, data={"data": QUERY}, headers=HEADERS, timeout=150)
    response.raise_for_status()
    elements = response.json()["elements"]

    features = [f for el in elements if (f := element_to_point_feature(el)) is not None]
    if not features:
        raise ValueError("Query returned zero gas stations — refusing to overwrite existing data")

    geojson = {"type": "FeatureCollection", "features": features}

    # Atomic write: a script that dies partway through never touches the
    # last-known-good committed file (see refresh_data.yml's continue-on-error).
    tmp_path = OUTPUT_PATH.with_suffix(".geojson.tmp")
    tmp_path.write_text(json.dumps(geojson), encoding="utf-8")
    os.replace(tmp_path, OUTPUT_PATH)

    print(f"Wrote {len(features)} gas stations to {OUTPUT_PATH}", file=sys.stderr)


if __name__ == "__main__":
    main()
