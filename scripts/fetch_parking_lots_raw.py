"""Fetches the FULL GGH-wide parking lot dataset (amenity=parking ways, via
Overpass) and writes a raw intermediate GeoJSON.

This raw file is a BUILD INPUT for tippecanoe, not a served asset — ~59k
polygons / ~26MB as GeoJSON, too large to bake directly (that's the whole
reason this layer used to be a live per-viewport Overpass query instead of a
baked /public/data file). Only the tiled output
(public/tiles/parking_lots.pmtiles, ~6MB) gets committed. Run this, then run
tippecanoe against its output.
"""

import json
import sys
from pathlib import Path

import requests

from bbox import OVERPASS_BBOX

OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter"
OUTPUT_PATH = Path(__file__).parent.parent / "build" / "parking_lots_raw.geojson"

# Overpass's server (or a fronting proxy) 406s requests.post's default
# "python-requests/x.x.x" User-Agent — a custom one clears it (see fetch_osm.py).
HEADERS = {"User-Agent": "ev-siting-map-fetch-script/1.0"}

QUERY = f"""
[out:json][timeout:120][bbox:{OVERPASS_BBOX}];
way[amenity=parking];
out geom;
"""


def element_to_feature(el: dict) -> dict | None:
    geometry = el.get("geometry")
    if not geometry or len(geometry) < 3:
        return None
    ring = [[pt["lon"], pt["lat"]] for pt in geometry]
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    return {
        "type": "Feature",
        "properties": {"id": el["id"], **el.get("tags", {})},
        "geometry": {"type": "Polygon", "coordinates": [ring]},
    }


def main() -> None:
    response = requests.post(OVERPASS_ENDPOINT, data={"data": QUERY}, headers=HEADERS, timeout=150)
    response.raise_for_status()
    elements = response.json()["elements"]

    features = [feat for el in elements if (feat := element_to_feature(el)) is not None]
    if not features:
        raise ValueError("Query returned zero parking lots — refusing to write an empty dataset")

    OUTPUT_PATH.parent.mkdir(exist_ok=True)
    geojson = {"type": "FeatureCollection", "features": features}
    OUTPUT_PATH.write_text(json.dumps(geojson), encoding="utf-8")

    print(f"Wrote {len(features)} parking lots to {OUTPUT_PATH}", file=sys.stderr)


if __name__ == "__main__":
    main()
