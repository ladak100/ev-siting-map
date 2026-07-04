"""Builds public/data/ev_chargers.geojson from a manually-downloaded NRCan
"Alternative Fuel Stations" CSV export (NREL's standard schema — Canada's
data is fed through the same US DOE Alternative Fuels Data Center format).

This is a MANUAL-refresh source, not part of the automated monthly cron: the
live ArcGIS FeatureServer the architecture doc originally pointed at
(services.arcgis.com/.../alt_fuel_stations) is dead — it now serves a single
all-null placeholder record. There's no working live API to poll, so re-run
this whenever a fresh export is manually placed in fuel-stations-data/
(gitignored — ~1.7MB raw file, not committed).

Every station in this export was already public/available (Access Code =
"public", Status Code = "E") and Canada/Ontario-only, so the only filtering
done here is Fuel Type Code == ELEC (drops LPG/CNG/HY entries) and the GGH bbox.

Charger type (L1/L2/DCFC) is NOT a single categorical field — a station can
have more than one port type simultaneously (39 of 2860 GGH stations have
both L2 and DCFC; 1 has both L1 and L2), so this writes independent
has_l1/has_l2/has_dcfc booleans rather than a mutually-exclusive "level"
string, matching how the sidebar filters them (independent checkboxes in the
EV Chargers filter menu, not a radio choice). L1 is nearly nonexistent here —
only 1 GGH station has any L1 ports — but it's cheap to expose for completeness.

network_group collapses any network with fewer than MIN_NETWORK_SIZE stations
in the GGH into "Other", so the network filter menu shows ~9 options instead
of ~28 (computed here rather than hardcoded, so it can't drift from the data).
"""

import csv
import json
import os
import sys
from collections import Counter
from pathlib import Path

from bbox import EAST, NORTH, SOUTH, WEST

INPUT_PATH = Path(__file__).parent.parent / "fuel-stations-data" / "alt_fuel_stations (Jul 4 2026).csv"
OUTPUT_PATH = Path(__file__).parent.parent / "public" / "data" / "ev_chargers.geojson"

MIN_NETWORK_SIZE = 40


def port_count(row: dict, field: str) -> int:
    value = row.get(field, "").strip()
    try:
        return int(float(value))
    except ValueError:
        return 0


def in_ggh_bbox(row: dict) -> bool:
    try:
        lat, lon = float(row["Latitude"]), float(row["Longitude"])
    except (KeyError, ValueError):
        return False
    return WEST <= lon <= EAST and SOUTH <= lat <= NORTH


def row_to_feature(row: dict, major_networks: set[str]) -> dict:
    lat, lon = float(row["Latitude"]), float(row["Longitude"])

    l1 = port_count(row, "EV Level1 EVSE Num")
    l2 = port_count(row, "EV Level2 EVSE Num")
    dcfc = port_count(row, "EV DC Fast Count")
    network = row.get("EV Network") or "Non-Networked"

    return {
        "type": "Feature",
        "properties": {
            "id": row.get("ID"),
            "name": row.get("Station Name") or None,
            "network": network,
            "network_group": network if network in major_networks else "Other",
            "city": row.get("City") or None,
            "address": row.get("Street Address") or None,
            "connector_types": row.get("EV Connector Types") or None,
            "l1_ports": l1,
            "l2_ports": l2,
            "dcfc_ports": dcfc,
            "total_ports": l1 + l2 + dcfc,
            "has_l1": l1 > 0,
            "has_l2": l2 > 0,
            "has_dcfc": dcfc > 0,
        },
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
    }


def main() -> None:
    with open(INPUT_PATH, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        elec_rows = [row for row in reader if row.get("Fuel Type Code") == "ELEC"]

    ggh_rows = [row for row in elec_rows if in_ggh_bbox(row)]
    if not ggh_rows:
        raise ValueError("Extracted zero EV chargers — check INPUT_PATH and bbox")

    network_counts = Counter(row.get("EV Network") or "Non-Networked" for row in ggh_rows)
    major_networks = {network for network, count in network_counts.items() if count >= MIN_NETWORK_SIZE}

    features = [row_to_feature(row, major_networks) for row in ggh_rows]
    geojson = {"type": "FeatureCollection", "features": features}

    tmp_path = OUTPUT_PATH.with_suffix(".geojson.tmp")
    tmp_path.write_text(json.dumps(geojson), encoding="utf-8")
    os.replace(tmp_path, OUTPUT_PATH)

    print(f"Wrote {len(features)} EV chargers to {OUTPUT_PATH}", file=sys.stderr)


if __name__ == "__main__":
    main()
