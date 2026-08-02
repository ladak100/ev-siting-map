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
"public", Status Code = "E"), so the only filtering done here is Fuel Type
Code == ELEC (drops LPG/CNG/HY entries) and State == "ON" — using the CSV's
own State field rather than bbox.py's rectangular bbox, since at Ontario's
scale that padded rectangle covers parts of Quebec/Manitoba/the US too (see
fetch_osm.py's comment on the same issue for OSM data).

Charger type (L1/L2/DCFC) is NOT a single categorical field — a station can
have more than one port type simultaneously (79 of 4756 Ontario stations have
both L2 and DCFC; 1 has both L1 and L2), so this writes independent
has_l1/has_l2/has_dcfc booleans rather than a mutually-exclusive "level"
string, matching how the sidebar filters them (independent checkboxes in the
EV Chargers filter menu, not a radio choice). L1 is nearly nonexistent here —
only 1 Ontario station has any L1 ports — but it's cheap to expose for completeness.

network_group collapses any network with fewer than MIN_NETWORK_SIZE stations
in Ontario into "Other", so the network filter menu shows ~9 options instead
of ~28 (computed here rather than hardcoded, so it can't drift from the data).
"""

import csv
import json
import os
import sys
from collections import Counter
from pathlib import Path

INPUT_PATH = Path(__file__).parent.parent / "fuel-stations-data" / "alt_fuel_stations (Jul 4 2026).csv"
OUTPUT_PATH = Path(__file__).parent.parent / "public" / "data" / "ev_chargers.geojson"

MIN_NETWORK_SIZE = 40

# Manual corrections for stations where NRCan's own upstream Latitude/
# Longitude are simply wrong (confirmed by comparing against the station's
# own Street Address, not just a hunch) — NRCan's "Geocode Status" column
# claims 'GPS' for these too, so there's no automatic signal in the CSV
# itself to detect this; each entry here was found by a user report and
# checked by hand. Keyed by the CSV's own stable 'ID' field, mapped to
# (longitude, latitude) — same coordinate order as the GeoJSON output.
#
#   298651 "Loblaws Bayview Village - Toronto": NRCan's row has
#   (43.63212, -79.35674) — a real coordinate, but on Centre Island /
#   Toronto's harbourfront, ~15km from the station's own listed address
#   (2877 Bayview Ave, M2K 2S3 — Bayview Village Shopping Centre, North
#   York, at Bayview Ave & Sheppard Ave E). Corrected to that address's
#   real location.
COORDINATE_OVERRIDES: dict[str, tuple[float, float]] = {
    "298651": (-79.3856, 43.7696),
}


def port_count(row: dict, field: str) -> int:
    value = row.get(field, "").strip()
    try:
        return int(float(value))
    except ValueError:
        return 0


def row_to_feature(row: dict, major_networks: set[str]) -> dict:
    override = COORDINATE_OVERRIDES.get(row.get("ID") or "")
    if override is not None:
        lon, lat = override
    else:
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

    on_rows = [row for row in elec_rows if row.get("State") == "ON"]
    if not on_rows:
        raise ValueError("Extracted zero EV chargers — check INPUT_PATH and the State field")

    network_counts = Counter(row.get("EV Network") or "Non-Networked" for row in on_rows)
    major_networks = {network for network, count in network_counts.items() if count >= MIN_NETWORK_SIZE}

    features = [row_to_feature(row, major_networks) for row in on_rows]
    geojson = {"type": "FeatureCollection", "features": features}

    tmp_path = OUTPUT_PATH.with_suffix(".geojson.tmp")
    tmp_path.write_text(json.dumps(geojson), encoding="utf-8")
    os.replace(tmp_path, OUTPUT_PATH)

    print(f"Wrote {len(features)} EV chargers to {OUTPUT_PATH}", file=sys.stderr)


if __name__ == "__main__":
    main()
