"""Fetches LDC Territory Boundaries from the OEB CCIM and writes a raw
intermediate GeoJSON.

This raw file is a BUILD INPUT for tippecanoe, not a served asset — the real
per-feature geometry here is dense enough that 25 features alone came to
4.93MB as plain GeoJSON, so it's tiled (like load_capacity and parking_lots)
rather than baked to public/data directly. Only the tiled output
(public/tiles/ldc_territories.pmtiles) gets committed. Run this, then run
tippecanoe against its output.

FeatureServer URL found by walking the CCIM Experience Builder app config:
  https://gis.planview.ca/portal/sharing/rest/content/items/81261dc17514429da65fbf52feca4c2e/data?f=json
  -> dataSources -> WEB_MAP item -> operationalLayers -> "Electricity Distributor"
It's hardcoded below rather than re-discovered on every run since it's stable
infrastructure, not something that changes month to month. If this script
starts failing, re-walk the app config above to check whether OEB re-published
under a new URL.
"""

import json
import sys
from pathlib import Path

import requests

from bbox import ARCGIS_ENVELOPE

LDC_TERRITORIES_URL = (
    "https://services7.arcgis.com/1Y0mbZeuC3Kpe5CZ/arcgis/rest/services/"
    "Electric_LDC_V2/FeatureServer/4/query"
)

OUTPUT_PATH = Path(__file__).parent.parent / "build" / "ldc_territories_raw.geojson"


def fetch_ldc_territories() -> dict:
    params = {
        "where": "1=1",
        "geometry": ARCGIS_ENVELOPE,
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "*",
        "f": "geojson",
    }
    response = requests.get(LDC_TERRITORIES_URL, params=params, timeout=30)
    response.raise_for_status()
    data = response.json()

    if data.get("type") != "FeatureCollection":
        raise ValueError(f"Unexpected response shape: {data}")

    feature_count = len(data.get("features", []))
    if feature_count == 0:
        raise ValueError("Query returned zero features — refusing to overwrite existing data")
    if feature_count >= 2000:
        # This layer normally has ~25 features in the GGH bbox. A count this
        # high suggests the server truncated the response (maxRecordCount)
        # and we'd need pagination like fetch_ev_chargers/fetch_ccim's
        # load-capacity counterpart already do — investigate before trusting this file.
        print(f"WARNING: {feature_count} features returned — check for server-side truncation", file=sys.stderr)

    return data


def main() -> None:
    data = fetch_ldc_territories()

    # No atomic write dance here (unlike a public/data/*.geojson target) —
    # build/ is a gitignored scratch dir consumed immediately by tippecanoe
    # in the same workflow step, not a committed last-known-good file.
    OUTPUT_PATH.parent.mkdir(exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(data), encoding="utf-8")

    print(f"Wrote {len(data['features'])} LDC territory features to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
