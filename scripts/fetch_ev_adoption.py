"""Builds a raw intermediate GeoJSON — one polygon per Forward Sortation
Area (FSA) in the GGH, carrying:
  - total_ev, ev_adoption_pct (latest MTO quarter)
  - houses_pct (StatsCan 2021 census dwelling structural type)
  - median_income (StatsCan 2021 census, characteristic 243 — "Median total
    income of household in 2020 ($)"; null where StatsCan suppresses it for
    low-population FSAs)
  - ev_by_quarter: the full historical time series (Q1 2022 -> latest), for
    charting EV growth in the click popup.

Three sources combine here:
  1. StatsCan CFSA boundaries (ArcGIS REST, geo.statcan.gc.ca)
  2. Ontario MTO's quarterly "Electric Vehicles by FSA" CSVs (data.ontario.ca,
     via CKAN), ALL quarters, not just the latest.
  3. scripts/data/census_dwellings_by_fsa.csv (committed, built once by
     extract_census_dwellings.py from the 645MB StatsCan census file, which
     is NOT re-fetched here — 2021 census data doesn't change).

Metric definitions were validated against evindex.ca's own displayed numbers
for two test FSAs (M5V, L6R) — see ev-siting-map-architecture.md. Notably:
ev_adoption_pct divides by "Total private dwellings" (incl. vacant/seasonal
units), NOT "occupied private dwellings" (actual households), despite
evindex's methodology page saying "household count" — that's what their
site's own numbers actually match.

This raw file is a BUILD INPUT for tippecanoe, not a served asset — at
~5.1MB plain GeoJSON it's small enough to have been baked directly, but
tiling still shrinks it ~11x with no functional loss (tippecanoe stringifies
the nested ev_by_quarter object into a JSON string property, which
evAdoptionPopup.ts's parseSeries() already handles via a JSON.parse
fallback). Only the tiled output (public/tiles/ev_adoption.pmtiles) gets
committed. Run this, then run tippecanoe against its output.
"""

import csv
import json
import re
import sys
from pathlib import Path

import requests

from bbox import ARCGIS_ENVELOPE

CFSA_LAYER_URL = "https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/MapServer/14/query"
MTO_PACKAGE_ID = "electric-vehicles-in-ontario-by-forward-sortation-area"
CKAN_PACKAGE_SHOW = "https://data.ontario.ca/api/3/action/package_show"

CENSUS_DWELLINGS_PATH = Path(__file__).parent / "data" / "census_dwellings_by_fsa.csv"
OUTPUT_PATH = Path(__file__).parent.parent / "build" / "ev_adoption_raw.geojson"

# The StatsCan MapServer 500s if a spatial (bbox) filter AND geometry are
# requested in the same call — but each works fine alone. So: bbox filter for
# just the FSA code list, then a separate IN-clause query (chunked to keep
# URLs a sane length) for geometry of just those codes.
FSA_CHUNK_SIZE = 50

QUARTER_NAME_RE = re.compile(r"^Q([1-4]) (\d{4})$")

# Suppresses ev_adoption_pct/houses_pct for FSAs with too few dwellings for
# the rate to mean anything (see the comment where this is used).
MIN_DWELLINGS_FOR_RATE = 50


def get_ggh_fsa_codes() -> list[str]:
    params = {
        "where": "1=1",
        "geometry": ARCGIS_ENVELOPE,
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "CFSAUID",
        "returnGeometry": "false",
        "f": "json",
    }
    response = requests.get(CFSA_LAYER_URL, params=params, timeout=30)
    response.raise_for_status()
    data = response.json()
    if "error" in data:
        raise RuntimeError(f"CFSA code query failed: {data['error']}")
    return [f["attributes"]["CFSAUID"] for f in data["features"]]


def fetch_fsa_boundaries(codes: list[str]) -> dict:
    features = []
    for i in range(0, len(codes), FSA_CHUNK_SIZE):
        chunk = codes[i : i + FSA_CHUNK_SIZE]
        where = "CFSAUID IN (" + ",".join(f"'{c}'" for c in chunk) + ")"
        params = {
            "where": where,
            "outFields": "CFSAUID",
            "outSR": "4326",
            "geometryPrecision": "5",
            "maxAllowableOffset": "0.0001",  # ~11m at this latitude — trims complex postal boundaries without visibly distorting them at web-map zoom
            "f": "geojson",
        }
        response = requests.get(CFSA_LAYER_URL, params=params, timeout=60)
        response.raise_for_status()
        data = response.json()
        if "error" in data:
            raise RuntimeError(f"CFSA geometry query failed for chunk starting {chunk[0]}: {data['error']}")
        features.extend(data["features"])

    if len(features) != len(codes):
        print(f"WARNING: requested {len(codes)} FSA boundaries, got {len(features)}", file=sys.stderr)

    return {"type": "FeatureCollection", "features": features}


def get_all_mto_quarters() -> list[tuple[int, int, str]]:
    """Returns [(year, quarter, download_url), ...] sorted oldest to newest."""
    response = requests.get(CKAN_PACKAGE_SHOW, params={"id": MTO_PACKAGE_ID}, timeout=30)
    response.raise_for_status()
    resources = response.json()["result"]["resources"]

    quarters = []
    for r in resources:
        m = QUARTER_NAME_RE.match(r.get("name", ""))
        if not m:
            continue  # e.g. skips the "Data dictionary" XLSX resource
        quarter, year = int(m.group(1)), int(m.group(2))
        quarters.append((year, quarter, r["url"]))

    quarters.sort()
    return quarters


def fetch_mto_quarter(url: str) -> dict[str, int]:
    response = requests.get(url, timeout=30)
    response.raise_for_status()
    lines = response.text.splitlines()

    # Column headers vary across quarters (e.g. "TotalEV" vs "Total EV"), so
    # parse by position (FSA, BEV, PHEV, TotalEV) rather than by header name.
    reader = csv.reader(lines[1:])
    counts: dict[str, int] = {}
    for row in reader:
        if len(row) < 4:
            continue
        fsa = row[0].strip()
        total = row[3].strip()
        counts[fsa] = int(total) if total else 0
    return counts


def load_census_dwellings() -> dict[str, dict[str, int]]:
    with open(CENSUS_DWELLINGS_PATH, encoding="utf-8", newline="") as f:
        return {row["fsa"]: row for row in csv.DictReader(f)}


def quarter_label(year: int, quarter: int) -> str:
    return f"{year}-Q{quarter}"


def main() -> None:
    print("Fetching GGH FSA code list...")
    codes = get_ggh_fsa_codes()
    print(f"  {len(codes)} FSAs in the GGH bbox")

    print("Fetching FSA boundary geometry...")
    boundaries = fetch_fsa_boundaries(codes)

    print("Fetching all MTO EV-by-FSA quarters...")
    quarters = get_all_mto_quarters()
    print(f"  {len(quarters)} quarters found: {quarter_label(*quarters[0][:2])} to {quarter_label(*quarters[-1][:2])}")

    ev_by_quarter_by_fsa: dict[str, dict[str, int]] = {}
    for year, quarter, url in quarters:
        label = quarter_label(year, quarter)
        print(f"  fetching {label}...")
        counts = fetch_mto_quarter(url)
        for fsa, total in counts.items():
            ev_by_quarter_by_fsa.setdefault(fsa, {})[label] = total

    latest_label = quarter_label(*quarters[-1][:2])

    print("Loading census dwelling data...")
    dwellings = load_census_dwellings()

    print("Joining and computing metrics...")
    matched = 0
    for feature in boundaries["features"]:
        fsa = feature["properties"]["CFSAUID"]
        props = feature["properties"]

        ev_series = ev_by_quarter_by_fsa.get(fsa, {})
        props["ev_by_quarter"] = ev_series
        props["total_ev"] = ev_series.get(latest_label, 0)

        row = dwellings.get(fsa)
        if row is None:
            props["ev_adoption_pct"] = None
            props["houses_pct"] = None
            props["median_income"] = None
            continue

        total_dwellings = int(row["total_private_dwellings"])
        occupied_by_type = int(row["occupied_by_type_total"])
        houses = int(row["single_detached"]) + int(row["semi_detached"]) + int(row["row_house"]) + int(row["other_single_attached"])

        props["median_income"] = int(row["median_income"]) if row["median_income"] else None

        # A handful of GGH FSAs are industrial/airport zones (e.g. L4V, L5S,
        # L5T near Pearson) with near-zero residential dwellings but nonzero
        # EV registrations (fleet vehicles, dealerships, leasing companies
        # tied to a business address there) — dividing by a near-zero
        # denominator produces a meaningless percentage spike (one hit 7900%).
        # 3 known FSAs sit under 10 dwellings; the next-smallest real
        # residential FSA is 257, so 50 cleanly isolates just the anomalies.
        props["ev_adoption_pct"] = round(props["total_ev"] / total_dwellings * 100, 2) if total_dwellings >= MIN_DWELLINGS_FOR_RATE else None
        props["houses_pct"] = round(houses / occupied_by_type * 100, 1) if occupied_by_type >= MIN_DWELLINGS_FOR_RATE else None
        matched += 1

    print(f"  {matched}/{len(boundaries['features'])} FSAs matched to census data")

    if matched == 0:
        raise ValueError("Zero FSAs matched census data — refusing to write a useless file")

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(boundaries), encoding="utf-8")
    print(f"Wrote {len(boundaries['features'])} features to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
