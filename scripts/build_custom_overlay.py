"""Builds the "split set" that powers the Custom Area Overview layer: the full
geometric intersection of Load Capacity feeder polygons and EV Adoption FSA
polygons, so a single tiled layer can carry both datasets' properties on the
same geometry.

Load Capacity (feeders) and EV Adoption/Income (FSAs) are two different
polygon sets that don't share boundaries — a feeder crosses FSA lines and vice
versa. Custom's "does this location satisfy both a load-capacity range AND an
FSA metric range" question can't be answered by a plain property filter on
either dataset alone. Instead of approximating (e.g. centroid lookup) or doing
that overlay math live in the browser, we cut every feeder x FSA overlap into
its own small polygon ONCE here, at build time, stamped with both parents'
properties. At runtime, Custom's sliders become a plain property filter
expression on this one precomputed layer — no client-side geometry math at all.

Prototype run against the real GGH data (43,309 feeders x 334 FSAs, bbox-
pruned via STRtree so this is NOT a naive 43,309*334 comparison): ~22s,
48,964 output features, 11.5MB once tiled — same ballpark as Load Capacity's
own pmtiles.

Reads build/load_capacity_raw.geojson and build/ev_adoption_raw.geojson (both
already produced as build inputs by fetch_load_capacity_raw.py and
fetch_ev_adoption.py earlier in the same workflow run) and writes
build/custom_overlay_raw.geojson, a further BUILD INPUT for tippecanoe. Run
this after both of those, then run tippecanoe against its output.
"""

import json
import sys
from pathlib import Path

from shapely.geometry import mapping, shape
from shapely.strtree import STRtree

LOAD_CAPACITY_PATH = Path(__file__).parent.parent / "build" / "load_capacity_raw.geojson"
EV_ADOPTION_PATH = Path(__file__).parent.parent / "build" / "ev_adoption_raw.geojson"
OUTPUT_PATH = Path(__file__).parent.parent / "build" / "custom_overlay_raw.geojson"
HISTOGRAM_OUTPUT_PATH = Path(__file__).parent.parent / "public" / "data" / "custom_overlay_histograms.json"

# The properties Custom's 5 sliders filter on, carried onto every split
# polygon alongside its parent feeder/FSA id (kept for debugging, not used at
# runtime — this layer has no popup, same as parking-lots).
FEEDER_PROPS = ("idldc", "capacity")
FSA_PROPS = ("CFSAUID", "ev_adoption_pct", "total_ev", "houses_pct", "median_income")

# Bounds + bin count for the small per-slider histograms shown in the Custom
# filter accordion. MUST match the <input type="range"> min/max attributes in
# index.html for each data-slider-field — the histogram bars are drawn under
# each slider's own track, so a mismatch here would misalign bars against the
# range they're supposed to represent.
HISTOGRAM_BOUNDS = {
    "capacity": (0, 180),
    "ev_adoption_pct": (0, 27),
    "total_ev": (0, 3400),
    "houses_pct": (0, 100),
    "median_income": (50000, 200000),
}
HISTOGRAM_BINS = 24


def load_valid_geometry(geometry: dict):
    """Real GGH feeder/FSA geometry has occasionally-invalid rings (self-
    touching boundaries etc.) that make shapely's intersection raise a
    TopologyException. buffer(0) is the standard shapely trick to rebuild a
    valid geometry with the same shape — confirmed necessary against the real
    data (one topology error on the very first prototype run)."""
    geom = shape(geometry)
    if not geom.is_valid:
        geom = geom.buffer(0)
    return geom


def compute_histogram(values: list, lo: float, hi: float, bins: int) -> list[int]:
    """A plain per-feature-count histogram, not area-weighted — most feeders
    stay whole (only ~13% split across an FSA boundary, per the prototype
    run), so feature count is a reasonable proxy for "how much land this bin
    represents" without needing an equal-area reprojection just for a rough
    visual aid in the filter UI."""
    counts = [0] * bins
    width = (hi - lo) / bins
    for v in values:
        if v is None:
            continue
        idx = int((v - lo) / width) if width > 0 else 0
        idx = max(0, min(bins - 1, idx))
        counts[idx] += 1
    return counts


def write_histograms(out_features: list) -> None:
    histograms = {}
    for field, (lo, hi) in HISTOGRAM_BOUNDS.items():
        values = [f["properties"].get(field) for f in out_features]
        histograms[field] = {"min": lo, "max": hi, "counts": compute_histogram(values, lo, hi, HISTOGRAM_BINS)}

    # Unlike OUTPUT_PATH (a build/ scratch file), this one is served directly
    # to the client — atomic write so a mid-run crash never leaves a
    # truncated file for the already-committed last-known-good version.
    HISTOGRAM_OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = HISTOGRAM_OUTPUT_PATH.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(histograms), encoding="utf-8")
    tmp_path.replace(HISTOGRAM_OUTPUT_PATH)
    print(f"Wrote histogram bins to {HISTOGRAM_OUTPUT_PATH}")


def main() -> None:
    print("Loading feeder and FSA geometry...")
    with open(LOAD_CAPACITY_PATH, encoding="utf-8") as f:
        feeders = json.load(f)["features"]
    with open(EV_ADOPTION_PATH, encoding="utf-8") as f:
        fsas = json.load(f)["features"]
    print(f"  {len(feeders)} feeders, {len(fsas)} FSAs")

    print("Building spatial index over FSAs...")
    fsa_geoms = [load_valid_geometry(f["geometry"]) for f in fsas]
    tree = STRtree(fsa_geoms)

    print("Computing feeder x FSA intersections...")
    out_features = []
    for feeder in feeders:
        fgeom = load_valid_geometry(feeder["geometry"])

        # STRtree.query is a bounding-box prune, not a real intersection test —
        # this is what makes 43k x 334 tractable instead of a full cross product.
        for idx in tree.query(fgeom):
            fsa_geom = fsa_geoms[idx]
            if not fsa_geom.intersects(fgeom):
                continue
            overlap = fsa_geom.intersection(fgeom)
            if overlap.is_empty or overlap.area == 0:
                continue
            if overlap.geom_type not in ("Polygon", "MultiPolygon"):
                continue  # edge/corner touches produce line or point slivers, not real area

            props = {k: feeder["properties"].get(k) for k in FEEDER_PROPS}
            props.update({k: fsas[idx]["properties"].get(k) for k in FSA_PROPS})
            out_features.append({"type": "Feature", "geometry": mapping(overlap), "properties": props})

    print(f"  {len(out_features)} split-set features")

    if not out_features:
        raise ValueError("Zero overlay features produced — refusing to write an empty dataset")

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": out_features}, f)
    print(f"Wrote {len(out_features)} features to {OUTPUT_PATH}")

    write_histograms(out_features)


if __name__ == "__main__":
    if not LOAD_CAPACITY_PATH.exists() or not EV_ADOPTION_PATH.exists():
        print(
            f"Missing build input(s) — expected both {LOAD_CAPACITY_PATH.name} and "
            f"{EV_ADOPTION_PATH.name} in build/. Run fetch_load_capacity_raw.py and "
            "fetch_ev_adoption.py first.",
            file=sys.stderr,
        )
        sys.exit(1)
    main()
