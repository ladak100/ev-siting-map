"""Builds build/zevip_corridor_raw.geojson (scored corridor lines) and
build/zevip_zone_raw.geojson (their 1.6km funding-eligibility zone) from
NRCan's ZEVIP "Charging_CorridorV2" ArcGIS MapServer, layer 0 only. Both are
BUILD INPUTS for tippecanoe, not served assets. Run this, then run
tippecanoe against both outputs.

MANUAL-refresh source, not part of the automated monthly cron: this server's
own /query endpoint never returns geometry, under any combination tried
(GET/POST, every SR including the service's native 3978, quantized, and even
f=pbf — which turned out to be plain JSON mislabeled with a protobuf
content-type, not real binary data). The /FeatureServer alias is a broken
ArcGIS Web Adaptor error page. No downloadable file exists anywhere in NRCan's
official listing either.

/identify is the one operation that DOES return real geometry, so this
sweeps it across a grid of bbox tiles (Ontario is too big for one request —
2.5deg cells match the largest single-request size already confirmed to work
cleanly in testing) and dedupes by OBJECTID.

/identify collapses exactly-overlapping duplicate records to one hit — this
is intentional, not a bug: NRCan's own data has many duplicate records for
the same physical road under multiple overlapping named corridor
designations (their own user guide: corridors include "the National Highway
System and select other long-distance inter-community roads ... identified
in collaboration with provinces and territories" — the same road can carry
more than one designation). Confirmed directly: the 5 largest duplicate
clusters in a test region had 16-30 records each, sharing identical
Corridor_Score/demand/capacity values down to the decimal. One line per
physical road is the correct output for a map, not a data-loss bug.

Note this dedup only catches EXACTLY-coincident duplicates — some corridor
designations are digitized as separate, slightly-offset parallel lines (e.g.
4 parallel lines on a single stretch of the 401), which /identify's
pixel-hit-test doesn't collapse. Those still render as genuinely separate
line features; the zone polygon below is unioned specifically so that
doesn't also double up as visibly darker overlapping bands.

bbox.py's bbox is a padded RECTANGLE (generous on purpose, see that file) —
at Ontario's scale that rectangle covers real chunks of Quebec, Manitoba,
and the US. A rectangular bbox intersection isn't enough here (confirmed:
without filtering, Highway 109 through Matagami, Quebec renders). Every
fetched segment is checked against Ontario's real boundary (StatsCan's own
PRUID=35 cartographic boundary polygon, fetched once below) and dropped if
it doesn't actually intersect Ontario.

/identify's `attributes` are keyed by field ALIAS (not raw field name), and
values come back as formatted STRINGS with embedded unit suffixes (e.g.
"33.43  kW/km") — stripped down to plain floats below.

The zone polygon is a real 1.6km buffer computed here (shapely + pyproj,
reprojected to EPSG:3978 — Canada Atlas Lambert, the same CRS this MapServer
itself natively uses — for accurate metric distances), not NRCan's own
buffer layer (layer 1 of the same MapServer): that polygon is a union of
independent per-segment circular buffers rather than one continuous buffer
of the merged route, so it renders as a string of overlapping circles at
every segment join (visually confirmed). Buffering here is done AFTER
unioning (dissolving) every corridor line together first, not per-segment —
Minkowski-sum buffering distributes over union, so this is mathematically
identical to buffering-then-unioning but far cheaper, and it also means
overlapping/near-duplicate parallel lines (see above) merge into one flat
shape with no double-opacity darkening, since the union happens on the
geometry itself rather than by stacking translucent renders at draw time.
"""

import json
import re
from pathlib import Path

import requests
from pyproj import Transformer
from shapely.geometry import mapping, shape
from shapely.ops import transform, unary_union

from bbox import EAST, NORTH, SOUTH, WEST

IDENTIFY_URL = "https://maps-cartes.services.geo.ca/server_serveur/rest/services/NRCan/Charging_CorridorV2_en/MapServer/identify"
PROVINCE_BOUNDARY_URL = "https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/MapServer/0/query"
ONTARIO_PRUID = "35"

OUTPUT_CORRIDOR_PATH = Path(__file__).parent.parent / "build" / "zevip_corridor_raw.geojson"
OUTPUT_ZONE_PATH = Path(__file__).parent.parent / "build" / "zevip_zone_raw.geojson"

HEADERS = {"User-Agent": "ev-siting-map-fetch-script/1.0"}

# Grid cell size in degrees — matches the largest bbox already confirmed to
# return complete, non-truncated /identify results in testing (~2.5x2.0deg).
CELL_SIZE_DEG = 2.5

ZONE_RADIUS_M = 1600
# Fewer segments per buffer corner than shapely's default (8) — plenty smooth
# at map zoom levels for a "mostly transparent shaded area", and keeps vertex
# count (hence tile size / render cost) down on a province-wide buffer.
ZONE_BUFFER_QUAD_SEGS = 4
# Simplifies the buffered outline after the fact — a precise buffer of a
# multi-thousand-segment merged line network has far more vertices than this
# visual actually needs.
ZONE_SIMPLIFY_TOLERANCE_M = 50

# Field alias -> our snake_case name — confirmed directly against live
# /identify responses, not assumed.
FIELD_MAP = {
    "Corridor Score": "corridor_score",
    "Estimated Average Demand ": "est_avg_demand_kw_km",
    "Estimated Required Capacity ": "est_required_capacity_kw",
    "Existing and Planned Infrastructure ": "existing_planned_infra_kw",
}

NUMBER_RE = re.compile(r"-?[\d.]+")

to_metric = Transformer.from_crs("EPSG:4326", "EPSG:3978", always_xy=True).transform
to_wgs84 = Transformer.from_crs("EPSG:3978", "EPSG:4326", always_xy=True).transform


def parse_value(raw: str | None) -> float | None:
    """Strips unit suffixes like "33.43  kW/km" down to a float."""
    if not raw:
        return None
    m = NUMBER_RE.match(raw.strip())
    return float(m.group()) if m else None


def remap_attributes(raw_attrs: dict) -> dict:
    props: dict = {"objectid": raw_attrs.get("OBJECTID")}
    for alias, key in FIELD_MAP.items():
        if alias in raw_attrs:
            props[key] = parse_value(raw_attrs[alias])
    return props


def esri_geometry_to_geojson(geometry: dict) -> dict:
    paths = geometry["paths"]
    return {"type": "LineString", "coordinates": paths[0]} if len(paths) == 1 else {"type": "MultiLineString", "coordinates": paths}


def build_grid() -> list[tuple[float, float, float, float]]:
    cells = []
    lon = WEST
    while lon < EAST:
        lon_end = min(lon + CELL_SIZE_DEG, EAST)
        lat = SOUTH
        while lat < NORTH:
            lat_end = min(lat + CELL_SIZE_DEG, NORTH)
            cells.append((lon, lat, lon_end, lat_end))
            lat = lat_end
        lon = lon_end
    return cells


def fetch_cell(xmin: float, ymin: float, xmax: float, ymax: float) -> list[dict]:
    params = {
        "geometry": json.dumps({"xmin": xmin, "ymin": ymin, "xmax": xmax, "ymax": ymax}),
        "geometryType": "esriGeometryEnvelope",
        "sr": "4326",
        "layers": "show:0",
        "tolerance": "0",
        "mapExtent": f"{xmin},{ymin},{xmax},{ymax}",
        "imageDisplay": "2000,2000,96",
        "returnGeometry": "true",
        "f": "json",
    }
    response = requests.get(IDENTIFY_URL, params=params, headers=HEADERS, timeout=60)
    response.raise_for_status()
    return response.json().get("results", [])


def fetch_ontario_boundary():
    params = {
        "where": f"PRUID='{ONTARIO_PRUID}'",
        "outFields": "PRUID",
        "outSR": "4326",
        "maxAllowableOffset": "0.001",  # ~111m — plenty for province-level classification
        "f": "geojson",
    }
    response = requests.get(PROVINCE_BOUNDARY_URL, params=params, headers=HEADERS, timeout=60)
    response.raise_for_status()
    data = response.json()
    if not data.get("features"):
        raise ValueError("Ontario boundary query returned zero features")
    return shape(data["features"][0]["geometry"])


def main() -> None:
    print("Fetching Ontario's real boundary (StatsCan PRUID=35)...")
    ontario_boundary = fetch_ontario_boundary()

    cells = build_grid()
    print(f"Sweeping {len(cells)} grid cells via /identify...")

    corridor_by_id: dict[str, dict] = {}

    for i, (xmin, ymin, xmax, ymax) in enumerate(cells):
        for r in fetch_cell(xmin, ymin, xmax, ymax):
            oid = str(r["attributes"].get("OBJECTID"))
            corridor_by_id.setdefault(oid, r)
        print(f"  cell {i + 1}/{len(cells)}: {len(corridor_by_id)} corridor segments so far")

    print("Filtering to segments that actually intersect Ontario (drops cross-border bleed from the padded bbox rectangle)...")
    kept_results = []
    dropped = 0
    for r in corridor_by_id.values():
        geom = shape(esri_geometry_to_geojson(r["geometry"]))
        if ontario_boundary.intersects(geom):
            kept_results.append(r)
        else:
            dropped += 1
    print(f"  kept {len(kept_results)}, dropped {dropped} (outside Ontario)")

    if not kept_results:
        raise ValueError("Extracted zero corridor segments — refusing to write empty data")

    corridor_geoms = [shape(esri_geometry_to_geojson(r["geometry"])) for r in kept_results]
    corridor_features = [
        {
            "type": "Feature",
            "properties": remap_attributes(r["attributes"]),
            "geometry": mapping(geom),
        }
        for r, geom in zip(kept_results, corridor_geoms)
    ]

    # No atomic tmp-write dance here (unlike a public/data/*.geojson target) —
    # build/ is a gitignored scratch dir consumed immediately by tippecanoe in
    # the same workflow step, not a committed last-known-good file.
    OUTPUT_CORRIDOR_PATH.parent.mkdir(exist_ok=True)
    OUTPUT_CORRIDOR_PATH.write_text(json.dumps({"type": "FeatureCollection", "features": corridor_features}), encoding="utf-8")
    print(f"Wrote {len(corridor_features)} corridor segments to {OUTPUT_CORRIDOR_PATH}")

    print("Building the eligibility zone: dissolving all corridor lines, buffering once, simplifying...")
    merged_lines = unary_union(corridor_geoms)
    merged_lines_metric = transform(to_metric, merged_lines)
    zone_metric = merged_lines_metric.buffer(ZONE_RADIUS_M, quad_segs=ZONE_BUFFER_QUAD_SEGS)
    zone_metric = zone_metric.simplify(ZONE_SIMPLIFY_TOLERANCE_M, preserve_topology=True)
    zone_wgs84 = transform(to_wgs84, zone_metric)

    zone_feature = {"type": "Feature", "properties": {}, "geometry": mapping(zone_wgs84)}
    OUTPUT_ZONE_PATH.write_text(json.dumps({"type": "FeatureCollection", "features": [zone_feature]}), encoding="utf-8")
    print(f"Wrote 1 dissolved zone polygon to {OUTPUT_ZONE_PATH}")


if __name__ == "__main__":
    main()
