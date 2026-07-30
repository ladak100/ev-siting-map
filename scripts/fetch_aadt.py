"""Builds public/data/aadt.geojson from MTO's public "Historical AADT & AADTT"
ArcGIS Feature Service, clipped to the GGH bbox.

MANUAL-refresh source, not part of the automated monthly cron: this service's
data is a frozen historical archive (years 1988-2019, last edited Jan 2023),
not something MTO actively updates — there's nothing new to pull on a
schedule. Re-run this only if MTO republishes a newer edition.

The service already carries real per-segment polyline geometry keyed by the
same LHRS/Offset linear-referencing fields as MTO's raw traffic-count tables
(confirmed by cross-checking field names), i.e. MTO has already done the
LHRS -> road-geometry resolution for us. 2019 (not the more recent 2021) is
used deliberately: 2021 counts are COVID-distorted, and it's also as recent
as this particular service goes.

Service discovered via the ArcGIS Hub "MTO iCorridor" portal
(icorridor-mto-on-ca.hub.arcgis.com) search API; confirmed public, no API key
needed, geometryType esriGeometryPolyline, 1,844 features province-wide / 524
within the GGH bbox.
"""

import json
import os
import sys
from pathlib import Path

import requests

from bbox import ARCGIS_ENVELOPE

AADT_URL = "https://services.arcgis.com/6iGx1Dq91oKtcE7x/arcgis/rest/services/Historical_AADT/FeatureServer/0/query"

OUTPUT_PATH = Path(__file__).parent.parent / "public" / "data" / "aadt.geojson"

# MTO's raw field -> this codebase's lowercase-snake_case convention.
FIELD_MAP = {
    "LHRS": "lhrs",
    "OFFSET": "offset",
    "HIGHWAY": "highway",
    "LENGTH": "length",
    "TRAFFICSEC": "traffic_section",
    "AADT19": "aadt",
    "AADTT19": "aadtt",
}


def fetch_aadt() -> dict:
    params = {
        "where": "1=1",
        "geometry": ARCGIS_ENVELOPE,
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": ",".join(FIELD_MAP),
        "f": "geojson",
    }
    response = requests.get(AADT_URL, params=params, timeout=30)
    response.raise_for_status()
    data = response.json()

    if data.get("type") != "FeatureCollection":
        raise ValueError(f"Unexpected response shape: {data}")

    feature_count = len(data.get("features", []))
    if feature_count == 0:
        raise ValueError("Query returned zero features — refusing to overwrite existing data")
    if feature_count >= 2000:
        # Confirmed 524 features in the GGH bbox at write time — a count this
        # high suggests server-side truncation (maxRecordCount), which would
        # need pagination like fetch_ev_chargers/fetch_ccim's load-capacity
        # counterpart already do. Investigate before trusting this file.
        print(f"WARNING: {feature_count} features returned — check for server-side truncation", file=sys.stderr)

    return data


def remap_properties(feature: dict) -> dict:
    old_props = feature["properties"]
    feature["properties"] = {new_key: old_props.get(old_key) for old_key, new_key in FIELD_MAP.items()}
    return feature


def main() -> None:
    data = fetch_aadt()
    data["features"] = [remap_properties(f) for f in data["features"]]

    tmp_path = OUTPUT_PATH.with_suffix(".geojson.tmp")
    tmp_path.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp_path, OUTPUT_PATH)

    print(f"Wrote {len(data['features'])} AADT segments to {OUTPUT_PATH}", file=sys.stderr)


if __name__ == "__main__":
    main()
