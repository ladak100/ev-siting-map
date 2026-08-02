"""Builds build/aadt_toronto_raw.geojson: an estimated AADT layer for Toronto
city streets, computed from the City of Toronto's own public short-term
traffic counts (Speed-Volume-Classification / "SVC" program), joined to real
street geometry from the Toronto Centreline (TCL) dataset. A BUILD INPUT for
tippecanoe, not a served asset — run this, then run tippecanoe against its
output.

WHY THIS EXISTS: the existing aadt.geojson (scripts/fetch_aadt.py) is MTO's
own province-wide AADT archive, but MTO's coverage is mostly provincial
highways — sparse within Toronto city limits. Toronto's own BDIT
(bdit_data-sources on GitHub) maintains a much denser count history, but its
detailed/continuous data (RESCU loop detectors, Miovision cameras, the
internal "bigdata" Postgres schema) is internal-only, not public. What IS
public — and what this script uses — is Toronto Open Data's CKAN-hosted SVC
dataset, the exact source BDIT's own SQL scripts are built on top of.

DATA SOURCES (Toronto Open Data CKAN, no API key needed):
  - svc_summary_data (SVC_SUMMARY_RESOURCE_ID below): the FULL count history,
    ~44.9k records, one row per count (a location can appear many times
    across different dates/years since 1993). Used ONLY to derive the
    empirical monthly seasonal-factor curve below, then discarded.
  - svc_most_recent_summary_data (SVC_LATEST_RESOURCE_ID): one row per
    location, its latest count (~14.4k records). The measured seed data the
    output layer is built from.
  - Toronto Centreline (TCL) GeoJSON (TCL_RESOURCE_ID): ~64.4k real
    LineString street-segment features, each with its own FEATURE_CODE_DESC
    road classification (Expressway/Major Arterial/Minor Arterial/Collector/
    Local/Laneway/etc.), LINEAR_NAME_ID (street identity), and
    FROM_INTERSECTION_ID/TO_INTERSECTION_ID (real street topology). This
    script keeps ONLY segments classed Minor Arterial and above (see
    IMPORTANT_ROAD_CLASSES) — PURGED at fetch time, not just filtered client-
    side, so Local/Laneway/Trail/River/etc. (the vast majority of TCL) never
    reach the output dataset, the tileset, or a user's browser at all.

METHODOLOGY — FHWA "Short Term Count ADT to AADT Conversion" (Traffic Data
Computation Method Pocket Guide, FHWA-PL-18-027, pgs. 78-79). SVC's own
avg_daily_vol is a raw multi-day count average — FHWA's "ADT", not "AADT" —
so turning it into an annualized estimate needs a day-of-week factor and a
month-of-year (seasonal) factor. The FHWA method normally sources both from
a nearby CONTINUOUS count station; Toronto doesn't publish one publicly (see
above), so both factors here are derived entirely from SVC's own public data:
  1. Day-of-week: SVC already reports avg_weekday_daily_vol and
     avg_weekend_daily_vol per count, so this needs no external factor —
     reconstruct a full 7-day estimate directly: (5*weekday + 2*weekend)/7.
  2. Month-of-year: derived empirically from svc_summary_data's repeat-visit
     locations (many Toronto streets were counted more than once, in
     different months, across the dataset's 30+ year span). For every
     location counted >=2 times, each count's volume is normalized against
     that location's own multi-visit mean; those ratios are then averaged
     by calendar month across every such location, producing a 12-value
     seasonal curve — a self-contained substitute for the "continuous
     station" the FHWA method calls for, built only from data Toronto
     already publishes.
  3. aadt_estimate = dow_corrected_adt * monthly_factor[count_month], for
     every SVC-measured location — see compute_measured_by_id.

GAP-FILLING (propagate_estimates): SVC counts are done at specific
representative blocks, not exhaustively on every block of a street — so
before this step, a rendered street looked "piecewise": colored where a
block happened to be counted, blank on the many blocks in between (the exact
issue a user flagged from a real map screenshot). TCL's own
FROM_INTERSECTION_ID/TO_INTERSECTION_ID topology lets uncounted blocks
inherit an estimate from the nearest counted block ON THE SAME STREET (via
LINEAR_NAME_ID — propagation never crosses onto a different street at an
intersection, so a busy cross-street's volume can't leak onto a quiet side
street it happens to touch). This is a multi-source BFS per street, capped
at MAX_PROPAGATION_HOPS so a long stretch with no real count anywhere near
it doesn't silently inherit a distant guess. Every output feature carries
is_measured (true = a real SVC count, false = interpolated) and
propagated_hops, so the map/popup can be honest about which is which.

KNOWN LIMITATIONS (accepted for v1, not bugs):
  - No change-rate/vintage-trending step: a measured location's estimate
    reflects whatever year IT was last counted in, not a common reference
    year. Vintage is carried through as count_date_start/count_date_end (null
    for interpolated segments, which have no count of their own) so the map
    can be honest about it.
  - No spatial dedup against the separate MTO aadt.geojson layer this is
    designed to render alongside (see layers.ts) — expected to be largely
    complementary (MTO = provincial highways, this = local streets), so
    overlap should be rare, but isn't checked for.
  - If a centreline_id has more than one distinct SVC count location on it,
    only one seeds that segment (dict overwrite in compute_measured_by_id) —
    not averaged or deduped further.
  - Propagation hops count TCL segments, not distance — a street built from
    many short blocks propagates farther (in real distance) than one built
    from a few long blocks, for the same hop cap.
"""

import json
import sys
from collections import defaultdict, deque
from datetime import datetime
from pathlib import Path

import requests

CKAN_BASE = "https://ckan0.cf.opendata.inter.prod-toronto.ca"
DATASTORE_SEARCH_URL = f"{CKAN_BASE}/api/3/action/datastore_search"
RESOURCE_SHOW_URL = f"{CKAN_BASE}/api/3/action/resource_show"

# Confirmed live via CKAN package_search / package_show / datastore_search
# during planning — see the plan doc for the full package-level detail.
SVC_SUMMARY_RESOURCE_ID = "b72cca3a-8190-47f7-8761-98f0b49bafc7"  # full history, ~44.9k records
SVC_LATEST_RESOURCE_ID = "e90038e7-ccb9-4bd2-af3e-696adc904c18"  # most-recent-per-location, ~14.4k records
TCL_RESOURCE_ID = "7bc94ccf-7bcf-4a7d-88b1-bdfc8ec5aaf1"  # Centreline - Version 2 - 4326.geojson

PAGE_SIZE = 5000
OUTPUT_PATH = Path(__file__).parent.parent / "build" / "aadt_toronto_raw.geojson"

# TCL's own join-key field name isn't pinned down from documentation alone —
# tried in this order against the first fetched feature's properties.
TCL_JOIN_FIELD_CANDIDATES = ["CENTRELINE_ID", "centreline_id", "OBJECTID", "GEO_ID"]
TCL_ROAD_CLASS_FIELD = "FEATURE_CODE_DESC"
TCL_LINEAR_NAME_FIELD = "LINEAR_NAME_ID"
TCL_FROM_INTERSECTION_FIELD = "FROM_INTERSECTION_ID"
TCL_TO_INTERSECTION_FIELD = "TO_INTERSECTION_ID"

# TCL road_class values kept — Minor Arterial and above. Collector was tried
# first and dropped (too close to Local in practice — e.g. Barton Ave's
# Collector-classed blocks carry similar volume to Local blocks nearby).
# Excludes Local, Laneway, and non-road TCL features (Trail, River, Hydro
# Line, etc.) — this is a PURGE (see fetch_tcl_segments), not a display
# filter, so those never make it into the output at all. Duplicated (by
# necessity, not laziness) as a plain list in src/layers.ts's own comments
# for the color-ramp/legend discussion — keep both in sync by hand if this
# set ever changes.
IMPORTANT_ROAD_CLASSES = {
    "Expressway",
    "Expressway Ramp",
    "Major Arterial",
    "Major Arterial Ramp",
    "Minor Arterial",
    "Minor Arterial Ramp",
}

# A location needs at least this many distinct counts before its own
# multi-visit mean is trustworthy enough to contribute to the seasonal curve.
MIN_VISITS_FOR_SEASONAL_FACTOR = 2

# Caps how many uncounted TCL segments in a row can inherit an estimate from
# one real count, along the same street — see the module docstring's
# GAP-FILLING section.
MAX_PROPAGATION_HOPS = 5


def datastore_total(resource_id: str) -> int:
    response = requests.get(DATASTORE_SEARCH_URL, params={"resource_id": resource_id, "limit": 0}, timeout=30)
    response.raise_for_status()
    return response.json()["result"]["total"]


def datastore_search_all(resource_id: str, total: int) -> list[dict]:
    # Total-driven, not short-page-driven — same reasoning as
    # fetch_load_capacity_raw.py's fetch_all_features: safer against a
    # server that (for whatever reason) returns a short-but-not-final page.
    records: list[dict] = []
    offset = 0
    while len(records) < total:
        params = {"resource_id": resource_id, "limit": PAGE_SIZE, "offset": offset}
        response = requests.get(DATASTORE_SEARCH_URL, params=params, timeout=60)
        response.raise_for_status()
        page = response.json()["result"]["records"]
        if not page:
            break  # safety net against infinite loop, shouldn't trigger before `total` is reached
        records.extend(page)
        print(f"  fetched {len(records)}/{total} records so far (offset {offset})")
        offset += PAGE_SIZE
    return records


def fetch_tcl_segments() -> list[dict]:
    """Fetches every TCL feature, keeping only IMPORTANT_ROAD_CLASSES — this
    is the purge step described in the module docstring: everything else
    (Local, Laneway, Trail, River, Hydro Line, etc.) is dropped here and
    never reaches the output. Returns one dict per kept segment with its
    geometry, road_class, street identity, and intersection topology."""
    print("Resolving Toronto Centreline (TCL) download URL...")
    response = requests.get(RESOURCE_SHOW_URL, params={"id": TCL_RESOURCE_ID}, timeout=30)
    response.raise_for_status()
    download_url = response.json()["result"]["url"]

    print(f"Fetching TCL geometry from {download_url}...")
    response = requests.get(download_url, timeout=120)
    response.raise_for_status()
    features = response.json()["features"]
    print(f"  {len(features)} TCL segments fetched")

    if not features:
        raise ValueError("TCL fetch returned zero features")

    join_field = next((f for f in TCL_JOIN_FIELD_CANDIDATES if f in features[0]["properties"]), None)
    if join_field is None:
        raise ValueError(
            f"None of {TCL_JOIN_FIELD_CANDIDATES} found in TCL properties: {list(features[0]['properties'])}"
        )
    print(f"  joining on TCL field '{join_field}'")

    segments = []
    for f in features:
        props = f["properties"]
        if props.get(TCL_ROAD_CLASS_FIELD) not in IMPORTANT_ROAD_CLASSES:
            continue
        key = props.get(join_field)
        if key is None:
            continue
        segments.append(
            {
                "centreline_id": str(key),
                "geometry": f["geometry"],
                "road_class": props.get(TCL_ROAD_CLASS_FIELD),
                "linear_name_id": props.get(TCL_LINEAR_NAME_FIELD),
                "from_id": props.get(TCL_FROM_INTERSECTION_FIELD),
                "to_id": props.get(TCL_TO_INTERSECTION_FIELD),
            }
        )
    print(f"  {len(segments)}/{len(features)} TCL segments kept (Minor Arterial and above, everything else purged)")
    return segments


def parse_float(value) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_month(date_str) -> int | None:
    if not date_str:
        return None
    try:
        return datetime.fromisoformat(str(date_str).replace("Z", "+00:00")).month
    except ValueError:
        try:
            return datetime.strptime(str(date_str)[:10], "%Y-%m-%d").month
        except ValueError:
            return None


def compute_monthly_factors(history: list[dict]) -> list[float]:
    """Empirical seasonal curve, derived from Toronto's own repeat-visit
    count locations (see module docstring, methodology step 2). Returns a
    12-element list indexed [0]=January .. [11]=December, averaging to 1.0."""
    by_location: dict[str, list[dict]] = defaultdict(list)
    for r in history:
        centreline_id = r.get("centreline_id")
        vol = parse_float(r.get("avg_daily_vol"))
        if centreline_id is None or vol is None or vol <= 0:
            continue
        by_location[str(centreline_id)].append(r)

    ratios_by_month: dict[int, list[float]] = defaultdict(list)
    repeat_locations = 0
    for records in by_location.values():
        if len(records) < MIN_VISITS_FOR_SEASONAL_FACTOR:
            continue
        vols = [parse_float(r["avg_daily_vol"]) for r in records]
        location_mean = sum(vols) / len(vols)
        if location_mean <= 0:
            continue
        repeat_locations += 1
        for r, vol in zip(records, vols):
            month = parse_month(r.get("count_date_start"))
            if month is not None:
                ratios_by_month[month].append(vol / location_mean)

    print(f"  {repeat_locations} locations had >={MIN_VISITS_FOR_SEASONAL_FACTOR} counts, contributing to the seasonal curve")

    raw_factors = []
    for month in range(1, 13):
        samples = ratios_by_month.get(month, [])
        raw_factors.append(sum(samples) / len(samples) if samples else 1.0)

    # Normalize so the 12 factors average to 1.0, per FHWA convention (see
    # pocket guide's monthly-factor discussion).
    overall_mean = sum(raw_factors) / len(raw_factors)
    factors = [f / overall_mean for f in raw_factors] if overall_mean > 0 else raw_factors

    print("  monthly factors (Jan..Dec): " + ", ".join(f"{f:.3f}" for f in factors))
    return factors


def extract_street_name(location_name: str | None) -> str | None:
    """SVC's own location_name is "<Street>: <CrossStreet1> - <CrossStreet2>"
    (e.g. "Bathurst St: Prince Charles Dr - Fairlawn Ave") — this is used as
    an interpolated segment's own title, since showing the exact block name
    of a DIFFERENT segment (the one that actually seeded its estimate) would
    be misleading; just the street name it belongs to is not."""
    if not location_name:
        return None
    return location_name.split(":", 1)[0].strip() or None


def dow_corrected_adt(record: dict) -> float | None:
    weekday = parse_float(record.get("avg_weekday_daily_vol"))
    weekend = parse_float(record.get("avg_weekend_daily_vol"))
    if weekday is not None and weekend is not None and weekday > 0:
        return (5 * weekday + 2 * weekend) / 7
    return parse_float(record.get("avg_daily_vol"))


def compute_measured_by_id(latest: list[dict], monthly_factors: list[float]) -> dict[str, dict]:
    """One entry per SVC location with a usable volume — keyed by
    centreline_id, the BFS seed set for propagate_estimates below. Not
    filtered by road_class here; segments outside IMPORTANT_ROAD_CLASSES
    simply won't appear in fetch_tcl_segments's output, so any measured
    value for one is naturally never used."""
    measured: dict[str, dict] = {}
    dropped_no_volume = 0
    for r in latest:
        centreline_id = r.get("centreline_id")
        if centreline_id is None:
            continue
        base_adt = dow_corrected_adt(r)
        if base_adt is None or base_adt <= 0:
            dropped_no_volume += 1
            continue
        month = parse_month(r.get("count_date_start"))
        factor = monthly_factors[month - 1] if month else 1.0
        measured[str(centreline_id)] = {
            "location_name": r.get("location_name"),
            "count_date_start": r.get("count_date_start"),
            "count_date_end": r.get("count_date_end"),
            "count_duration": r.get("count_duration"),
            "avg_daily_vol": parse_float(r.get("avg_daily_vol")),
            "aadt_estimate": round(base_adt * factor),
            "monthly_factor_applied": round(factor, 3),
        }
    print(f"  {len(measured)} locations with a usable measured ADT, {dropped_no_volume} dropped (no usable volume)")
    return measured


def propagate_estimates(segments: list[dict], measured_by_id: dict[str, dict]) -> list[dict]:
    """Multi-source BFS, run independently per street (grouped by
    linear_name_id): every measured segment seeds the search at hop 0, then
    floods outward through TCL's own FROM/TO_INTERSECTION_ID topology to
    fill in adjacent unmeasured segments — never crossing onto a
    differently-named street, and never exceeding MAX_PROPAGATION_HOPS. See
    the module docstring's GAP-FILLING section for why."""
    by_street: dict[object, list[dict]] = defaultdict(list)
    for s in segments:
        # A null linear_name_id (e.g. some ramps) would otherwise lump every
        # such segment into one giant fake "street" — give each its own
        # solo group instead, so it can only seed/receive from itself.
        key = s["linear_name_id"] if s["linear_name_id"] is not None else f"__solo_{s['centreline_id']}"
        by_street[key].append(s)

    features = []
    measured_count = 0
    propagated_count = 0
    unresolved_count = 0

    for street_segments in by_street.values():
        by_endpoint: dict[object, list[dict]] = defaultdict(list)
        for s in street_segments:
            by_endpoint[s["from_id"]].append(s)
            by_endpoint[s["to_id"]].append(s)

        # value_by_cid: centreline_id -> (aadt_estimate, hops_from_nearest_measurement,
        # is_measured, source_location_name — the measured segment's own
        # location_name that this value ultimately came from, carried through
        # every hop of the BFS so an interpolated segment still knows which
        # real count produced its number)
        value_by_cid: dict[str, tuple[float, int, bool, str | None]] = {}
        queue: deque[dict] = deque()
        for s in street_segments:
            m = measured_by_id.get(s["centreline_id"])
            if m is not None:
                value_by_cid[s["centreline_id"]] = (m["aadt_estimate"], 0, True, m["location_name"])
                queue.append(s)

        while queue:
            current = queue.popleft()
            current_value, current_hops, _, source_location_name = value_by_cid[current["centreline_id"]]
            if current_hops >= MAX_PROPAGATION_HOPS:
                continue
            for endpoint in (current["from_id"], current["to_id"]):
                if endpoint is None:
                    continue
                for neighbor in by_endpoint.get(endpoint, []):
                    if neighbor["centreline_id"] in value_by_cid:
                        continue
                    value_by_cid[neighbor["centreline_id"]] = (current_value, current_hops + 1, False, source_location_name)
                    queue.append(neighbor)

        for s in street_segments:
            resolved = value_by_cid.get(s["centreline_id"])
            if resolved is None:
                unresolved_count += 1
                continue
            value, hops, is_measured, source_location_name = resolved
            m = measured_by_id.get(s["centreline_id"]) if is_measured else None

            properties = {
                "centreline_id": s["centreline_id"],
                "road_class": s["road_class"],
                "location_name": m["location_name"] if m else extract_street_name(source_location_name),
                "count_date_start": m["count_date_start"] if m else None,
                "count_date_end": m["count_date_end"] if m else None,
                "count_duration": m["count_duration"] if m else None,
                "avg_daily_vol": m["avg_daily_vol"] if m else None,
                "aadt_estimate": round(value),
                "monthly_factor_applied": m["monthly_factor_applied"] if m else None,
                "is_measured": is_measured,
                "propagated_hops": hops,
                "data_source": "Toronto SVC (estimated)" if is_measured else "Toronto SVC (estimated, interpolated)",
            }
            features.append({"type": "Feature", "properties": properties, "geometry": s["geometry"]})
            if is_measured:
                measured_count += 1
            else:
                propagated_count += 1

    print(
        f"  {measured_count} measured, {propagated_count} interpolated "
        f"(within {MAX_PROPAGATION_HOPS} hops of a real count), {unresolved_count} unresolved (no nearby count)"
    )
    return features


def main() -> None:
    print("Fetching full SVC count history (for seasonal-factor derivation)...")
    history_total = datastore_total(SVC_SUMMARY_RESOURCE_ID)
    print(f"  {history_total} total records")
    history = datastore_search_all(SVC_SUMMARY_RESOURCE_ID, history_total)

    print("Computing empirical monthly seasonal factors from repeat-visit locations...")
    monthly_factors = compute_monthly_factors(history)
    del history  # only needed for the factor curve above — see module docstring

    print("Fetching most-recent-per-location SVC counts...")
    latest_total = datastore_total(SVC_LATEST_RESOURCE_ID)
    print(f"  {latest_total} total records")
    latest = datastore_search_all(SVC_LATEST_RESOURCE_ID, latest_total)

    print("Computing measured AADT estimates per location...")
    measured_by_id = compute_measured_by_id(latest, monthly_factors)

    print("Fetching Toronto Centreline (TCL), purged to Minor Arterial and above...")
    segments = fetch_tcl_segments()

    print("Propagating estimates along each street's own topology to fill gaps between counts...")
    features = propagate_estimates(segments, measured_by_id)

    if not features:
        raise ValueError("Extracted zero Toronto AADT features — refusing to write an empty dataset")

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps({"type": "FeatureCollection", "features": features}), encoding="utf-8")
    print(f"Wrote {len(features)} Toronto AADT features to {OUTPUT_PATH}", file=sys.stderr)


if __name__ == "__main__":
    main()
