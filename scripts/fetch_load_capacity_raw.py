"""Fetches the FULL OEB CCIM Available Load Capacity dataset (~45k feeder
polygons across the GGH, fully paginated past the server's 2000/request cap)
and writes a raw intermediate GeoJSON.

This raw file is a BUILD INPUT for tippecanoe, not a served asset — at ~100MB
it's far too large to commit or serve directly (that's the whole reason this
layer became a tiled vector layer instead of a baked /public/data file, see
ev-siting-map-architecture.md). Only the tiled output (public/tiles/load_capacity.pmtiles)
gets committed. Run this, then run tippecanoe against its output.
"""

import json
import sys
from pathlib import Path

import requests

from bbox import ARCGIS_ENVELOPE

LOAD_CAPACITY_URL = (
    "https://gis.planview.ca/server/rest/services/OEB/"
    "OEB_Available_Capacity/FeatureServer/0/query"
)

PAGE_SIZE = 2000
OUTPUT_PATH = Path(__file__).parent.parent / "build" / "load_capacity_raw.geojson"


def get_total_count() -> int:
    params = {
        "where": "1=1",
        "geometry": ARCGIS_ENVELOPE,
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "returnCountOnly": "true",
        "f": "json",
    }
    response = requests.get(LOAD_CAPACITY_URL, params=params, timeout=30)
    response.raise_for_status()
    return response.json()["count"]


def fetch_all_features(total: int) -> list:
    # NOTE: pagination here is driven by the known `total` count, not by
    # "did this page come back short" — with a spatial filter layered on top
    # of objectid-ordered paging, feeder density isn't uniform across
    # objectid ranges, so a short page doesn't mean we've exhausted the
    # dataset (this caused a silent under-fetch: 3934 of 44736 features on
    # the first attempt). orderByFields is required too, since offset-based
    # paging is only well-defined against a stable sort order.
    features: list = []
    offset = 0

    while len(features) < total:
        params = {
            "where": "1=1",
            "geometry": ARCGIS_ENVELOPE,
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "idldc,ldc_name,capacityrange,capacity,last_update",
            "orderByFields": "objectid",
            "resultOffset": offset,
            "resultRecordCount": PAGE_SIZE,
            "f": "geojson",
        }
        response = requests.get(LOAD_CAPACITY_URL, params=params, timeout=60)
        response.raise_for_status()
        page_features = response.json().get("features", [])
        if not page_features:
            break  # safety net against infinite loop, shouldn't trigger before `total` is reached
        features.extend(page_features)
        print(f"  fetched {len(features)}/{total} features so far (offset {offset})")
        offset += PAGE_SIZE

    return features


def main() -> None:
    total = get_total_count()
    print(f"Server reports {total} features intersecting the GGH bbox")

    features = fetch_all_features(total)
    if not features:
        raise ValueError("Query returned zero features — refusing to write an empty dataset")
    if len(features) != total:
        print(f"WARNING: expected {total} features but fetched {len(features)} — dataset may be incomplete", file=sys.stderr)

    OUTPUT_PATH.parent.mkdir(exist_ok=True)
    geojson = {"type": "FeatureCollection", "features": features}
    OUTPUT_PATH.write_text(json.dumps(geojson), encoding="utf-8")
    print(f"Wrote {len(features)} load capacity features to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
