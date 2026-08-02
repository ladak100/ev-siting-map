export type LayerType = 'fill' | 'line' | 'circle' | 'symbol';

// Paths are relative to Vite's BASE_URL (e.g. '/ev-siting-map/'), NOT the
// domain root — resolve with `${import.meta.env.BASE_URL}${path}` at the
// call site. A hardcoded leading-slash path like '/data/x.geojson' 404s once
// deployed under a repo subpath, since it ignores the configured base entirely.
export type LayerSource =
  | { kind: 'geojson'; path: string }
  | { kind: 'vector'; path: string; sourceLayer: string };

export interface LayerConfig {
  /** Unique id — also the checkbox data-layer-id in index.html */
  id: string;
  label: string;
  /** Shared source id. Multiple LayerConfigs may point at the same sourceId
   *  (e.g. ev-chargers-l2 / ev-chargers-dcfc both read the ev_chargers source
   *  and split it via `filter`), so the source is only fetched once. */
  sourceId: string;
  source: LayerSource;
  type: LayerType;
  // Loosely typed rather than MapLibre's strict *LayerSpecification['paint']
  // unions — those reject a literal `null` inside a ['==', ..., null] check
  // (used for the ev-adoption null-guards), and main.ts already applies this
  // via an `as never` cast when calling addLayer, so the stricter type
  // wasn't buying real end-to-end safety anyway.
  paint: Record<string, unknown>;
  /** Extra layout properties beyond `visibility` (which addStaticLayers
   *  always sets itself) — e.g. gas-stations' icon-image/icon-size. */
  layout?: Record<string, unknown>;
  /** MapLibre filter expression, for layers that split a shared source */
  filter?: unknown[];
  defaultVisible: boolean;
  minZoom?: number;
}

// NOTE: every layer below is confirmed against real data — see
// scripts/fetch_ccim.py, scripts/fetch_load_capacity_raw.py,
// scripts/fetch_ev_adoption.py, and scripts/extract_ev_chargers.py.
//
// Array order is render order, bottom to top: MapLibre stacks layers by
// addLayer call order regardless of visibility (main.ts's addStaticLayers
// just loops over this array with no beforeId), so a layer's position here
// IS its z-order. Bottom to top: the FSA-level Fill Layers choropleths, then
// Load Capacity, then Custom Overlay, then Parking Lots, then the Road
// Layers (AADT — both the MTO layer and its Toronto-local companion, see
// controls.ts's COMPANION_SUFFIXES — and ZEVIP Corridor Score), then the
// point layers (EV Chargers / Gas Stations), then LDC Territories on top of
// everything (also pinned there explicitly via map.moveLayer in main.ts,
// belt-and-suspenders against future reordering here).
// MTO's own official AADT legend tiers (magenta/pink/plum sequential ramp) —
// shared by 'aadt' and 'aadt-toronto' so the same color always means the
// same volume range regardless of which dataset a segment came from. Kept
// as [threshold, color] stops rather than two separately-typed-out `step`
// expressions, since the two layers read different property names
// ('aadt' vs 'aadt_estimate' — see aadtLineColorRamp below) but must stay
// pixel-identical otherwise. Previously aadt-toronto had its own ramp
// calibrated to its (much lower) real spread, but the user asked to just
// reuse MTO's tiers directly instead — most Toronto segments now land in
// the bottom 2-3 tiers rather than spreading across the full ramp, which is
// an accepted trade-off for a single consistent legend over the merged layer.
const AADT_COLOR_STOPS: [number, string][] = [
  [0, '#fdeaf3'], // 0 - 5,000
  [5000, '#fbd0e5'], // 5,000 - 10,000
  [10000, '#f7b0d3'], // 10,000 - 20,000
  [20000, '#f28fc0'], // 20,000 - 50,000
  [50000, '#e96daa'], // 50,000 - 100,000
  [100000, '#d84f92'], // 100,000 - 150,000
  [150000, '#bc3b7d'], // 150,000 - 200,000
  [200000, '#9c2f68'], // 200,000 - 250,000
  [250000, '#7c2454'], // 250,000 - 300,000
  [300000, '#591a3d'], // > 300,000 - 500,000
];

function aadtLineColorRamp(property: string): unknown[] {
  const [zero, ...rest] = AADT_COLOR_STOPS;
  const expr: unknown[] = ['step', ['get', property], zero[1]];
  for (const [threshold, color] of rest) expr.push(threshold, color);
  return expr;
}

// Below ROAD_WIDTH_SCALE_ZOOM, width stays constant at each layer's own base
// width (MapLibre's `interpolate` clamps to the first stop's value below it)
// — roads are thin at low zoom regardless, so there's nothing to gain from
// widening them there. Above it, width grows linearly with zoom, purely to
// make roads easier to click once you're zoomed in enough to be picking out
// an individual block — a user-reported click-target problem, not a visual
// design change (colors/opacity are untouched). 14 is a starting guess
// (roughly where individual city blocks become legible); adjust freely.
// Shared by every Road Layers line layer — aadt/aadt-toronto (+ casings) and
// zevip-corridor (+ casing) — same click-target problem on all of them.
const ROAD_WIDTH_SCALE_ZOOM = 14;
const ROAD_WIDTH_MAX_ZOOM = 18;

function zoomScaledWidth(baseWidth: number, maxWidth: number): unknown[] {
  return ['interpolate', ['linear'], ['zoom'], ROAD_WIDTH_SCALE_ZOOM, baseWidth, ROAD_WIDTH_MAX_ZOOM, maxWidth];
}

export const layerConfigs: LayerConfig[] = [
  {
    // ev-adoption-pct / ev-adoption-total / ev-adoption-housing share one
    // source (built by scripts/fetch_ev_adoption.py: StatsCan CFSA boundaries
    // + all historical Ontario MTO EV-by-FSA quarters + the committed census
    // dwellings extract — 520 Ontario-wide FSA polygons) and are three separate
    // Fill Layers radio choices, all sequential magnitudes so all three reuse
    // the same green hue (per the dataviz skill: a second hue is only needed
    // when two sequential contexts are visible AT ONCE — these are radio-
    // exclusive, never simultaneous), just calibrated to each metric's own
    // real range. fill-opacity zeroes out (transparent, not grey) wherever
    // the underlying value is null — e.g. the 3 near-zero-household
    // industrial FSAs the fetch script suppresses (see MIN_DWELLINGS_FOR_RATE).
    //
    // Real Ontario-wide spread: min 0%, median 3.9%, p90 10.2%, max 42.6% (a
    // handful of rural outliers) — the ramp still tops out at 20% since the
    // vast majority of FSAs sit well under that; outliers above it just clamp
    // to the same darkest shade rather than fighting for visual range with
    // the bulk of the data.
    //
    // Pre-tiled via tippecanoe (~5.1MB plain GeoJSON -> ~0.46MB pmtiles,
    // ~11x). The nested ev_by_quarter property (popup sparkline data)
    // survives as a tippecanoe-stringified JSON string, which
    // evAdoptionPopup.ts's parseSeries() already parses.
    id: 'ev-adoption-pct',
    label: 'EV Adoption by FSA (%)',
    sourceId: 'ev-adoption',
    source: { kind: 'vector', path: 'tiles/ev_adoption.pmtiles', sourceLayer: 'ev_adoption' },
    type: 'fill',
    paint: {
      'fill-color': [
        'interpolate',
        ['linear'],
        ['get', 'ev_adoption_pct'],
        0, '#d4edd9',
        3, '#9ecca8',
        6, '#5fa66e',
        10, '#327a45',
        20, '#14431f',
      ],
      'fill-opacity': ['case', ['==', ['get', 'ev_adoption_pct'], null], 0, 0.6],
    },
    defaultVisible: false,
  },
  {
    id: 'ev-adoption-total',
    label: 'Total EVs',
    sourceId: 'ev-adoption',
    source: { kind: 'vector', path: 'tiles/ev_adoption.pmtiles', sourceLayer: 'ev_adoption' },
    type: 'fill',
    // Calibrated to this dataset's real spread (min 0, median 380, p90 1056, max 3547)
    paint: {
      'fill-color': [
        'interpolate',
        ['linear'],
        ['get', 'total_ev'],
        0, '#d4edd9',
        300, '#9ecca8',
        700, '#5fa66e',
        1500, '#327a45',
        3400, '#14431f',
      ],
      'fill-opacity': 0.6,
    },
    defaultVisible: false,
  },
  {
    id: 'ev-adoption-housing',
    label: 'Houses & Townhomes (%)',
    sourceId: 'ev-adoption',
    source: { kind: 'vector', path: 'tiles/ev_adoption.pmtiles', sourceLayer: 'ev_adoption' },
    type: 'fill',
    paint: {
      'fill-color': [
        'interpolate',
        ['linear'],
        ['get', 'houses_pct'],
        0, '#d4edd9',
        25, '#9ecca8',
        50, '#5fa66e',
        75, '#327a45',
        100, '#14431f',
      ],
      'fill-opacity': ['case', ['==', ['get', 'houses_pct'], null], 0, 0.6],
    },
    defaultVisible: false,
  },
  {
    // Shares the ev-adoption source too (see the comment on ev-adoption-pct
    // above) — median_income comes from the same StatsCan Census Profile
    // pull as the dwelling data, just characteristic 243 instead. Originally
    // planned as a separate DA-level layer (id "income-da"), but since we'd
    // already built the FSA-level pipeline for EV adoption, extending that
    // was far less work than a whole separate DA-boundary join, and keeps
    // every Fill Layers layer at the same FSA granularity.
    id: 'household-income',
    label: 'Household Income ($)',
    sourceId: 'ev-adoption',
    source: { kind: 'vector', path: 'tiles/ev_adoption.pmtiles', sourceLayer: 'ev_adoption' },
    type: 'fill',
    // Calibrated to this dataset's real spread (min $45.2k, median $90k, p90 $128k, max $198k)
    paint: {
      'fill-color': [
        'interpolate',
        ['linear'],
        ['get', 'median_income'],
        50000, '#d4edd9',
        75000, '#9ecca8',
        100000, '#5fa66e',
        140000, '#327a45',
        200000, '#14431f',
      ],
      'fill-opacity': ['case', ['==', ['get', 'median_income'], null], 0, 0.6],
    },
    defaultVisible: false,
  },
  {
    id: 'load-capacity',
    label: 'Available Load Capacity (MVA)',
    sourceId: 'load-capacity',
    // Pre-tiled via tippecanoe (scripts/fetch_load_capacity_raw.py -> tippecanoe),
    // not a live query and not a single baked GeoJSON: the full Ontario dataset
    // is ~132k feeder polygons / ~280MB as GeoJSON, too large to bake or query
    // per-viewport reliably. The .pmtiles archive is ~34MB, self-hosted, no
    // billing/API key, and MapLibre only fetches the tiles a given view needs.
    //
    // Colors are the dataviz skill's fixed status palette (good/warning/serious/
    // critical) — "available capacity" is a genuine good/bad signal, not arbitrary
    // category identity, so it wears status tokens rather than a hand-picked ramp.
    // The real data has 5 buckets ('1.1 - 3.0' and '3.1 - 5.0' are distinct); both
    // collapse into the single [1,5) "serious" tier per the requested 4-tier legend.
    source: { kind: 'vector', path: 'tiles/load_capacity.pmtiles', sourceLayer: 'load_capacity' },
    type: 'fill',
    paint: {
      'fill-color': [
        'match',
        ['get', 'capacityrange'],
        '0.0 - 1.0', '#b8433f', // red
        '1.1 - 3.0', '#c7a832', // yellow
        '3.1 - 5.0', '#c7a832', // yellow
        '5.1 - 10.0', '#8ba33e', // yellow-green
        '10.0 +', '#1f7a3d', // dark green
        /* fallback, incl. null */ '#9a9890',
      ],
      'fill-opacity': 0.55,
    },
    defaultVisible: true,
  },
  {
    // The "site selection" overlay: a single precomputed layer of every
    // feeder x FSA polygon overlap (built by scripts/build_custom_overlay.py
    // via shapely, since Load Capacity's feeders and EV Adoption's FSAs are
    // two different polygon sets that don't share boundaries — see that
    // script's docstring). Every split polygon carries both parents'
    // properties, so all 5 of Custom's sliders (see customOverlayFilters.ts)
    // are answered with one plain MapLibre `filter` expression on this one
    // source — no client-side geometry math at runtime. Non-matching
    // polygons are excluded by the filter entirely (not just faded), which
    // is what makes only the qualifying areas paint orange. No popup —
    // this is a "candidate area" indicator, not a data-inspection layer.
    id: 'custom-overlay',
    label: 'Custom',
    sourceId: 'custom-overlay',
    source: { kind: 'vector', path: 'tiles/custom_overlay.pmtiles', sourceLayer: 'custom_overlay' },
    type: 'fill',
    paint: {
      'fill-color': '#dd6b20',
      'fill-opacity': 0.6,
    },
    defaultVisible: false,
  },
  {
    // Used to be a live per-viewport Overpass query (~91k Ontario-wide polygons,
    // too big to bake as plain GeoJSON, same reasoning as
    // load-capacity). Baking it as tiles instead — same pipeline as
    // load-capacity (scripts/fetch_parking_lots_raw.py -> tippecanoe) —
    // dropped per-session load time from "live query against a shared public
    // Overpass server" to "static tiles off our own CDN," at the cost of one
    // more file to keep refreshed. Background context only, so no popup
    // (see main.ts) and a subtle, low-contrast fill.
    id: 'parking-lots',
    label: 'Parking Lots',
    sourceId: 'parking-lots',
    source: { kind: 'vector', path: 'tiles/parking_lots.pmtiles', sourceLayer: 'parking_lots' },
    type: 'fill',
    paint: {
      'fill-color': '#d9d9d9',
      'fill-outline-color': '#a6a6a6',
    },
    defaultVisible: true,
    minZoom: 13,
  },
  {
    // A dark casing rendered under the actual aadt line (added first here so
    // it stacks below), same "wider line underneath" trick every road-casing
    // style uses — plain line layers have no native border/stroke property
    // the way circle layers do. Shares aadt's own source/geometry, so it's
    // wired as a checkbox-companion layer the same way ldc-territories-labels
    // rides along with ldc-territories (see controls.ts's `-casing` handling
    // in initLayerCheckboxes).
    id: 'aadt-casing',
    label: 'Traffic Volume (AADT) casing',
    sourceId: 'aadt',
    source: { kind: 'geojson', path: 'data/aadt.geojson' },
    type: 'line',
    paint: {
      'line-color': '#333333',
      'line-width': zoomScaledWidth(4.5, 12),
    },
    defaultVisible: false,
  },
  {
    // Sourced from MTO's public "Historical AADT & AADTT" ArcGIS Feature
    // Service (scripts/fetch_aadt.py) — MTO has already resolved their own
    // LHRS+Offset linear referencing into real per-segment polyline geometry,
    // so this is a plain committed GeoJSON like ev-chargers/gas-stations, no
    // tippecanoe tiling needed at only 1,844 Ontario features. 2019 data (AADT19)
    // deliberately, not the more recent 2021: COVID-distorted counts would
    // understate a "normal" baseline, and it's also as recent as this
    // particular MTO archive goes (last edited Jan 2023, not live-updated —
    // see fetch_aadt.py for why this is a manual-refresh source).
    //
    // Colors and breaks match MTO's own official AADT legend exactly (a
    // magenta/pink/plum sequential ramp) rather than this app's usual green
    // Fill Layers ramp — deliberately a distinct hue, since this is a Road
    // Layers radio choice (a separate radio group from Fill Layers, see
    // controls.ts) and so can be visible at the same time as a green
    // choropleth underneath it. zevip-corridor below reuses this exact same
    // palette, since the two are radio-exclusive siblings in that same group.
    //
    // No minZoom — unlike the point/parking-lots detail layers, a traffic
    // segment is meaningful information at any zoom, not just close-up.
    id: 'aadt',
    label: 'Traffic Volume (AADT)',
    sourceId: 'aadt',
    source: { kind: 'geojson', path: 'data/aadt.geojson' },
    type: 'line',
    paint: {
      'line-color': aadtLineColorRamp('aadt'),
      'line-width': zoomScaledWidth(3, 9),
    },
    defaultVisible: false,
  },
  {
    // Rides along as a companion of 'aadt' (see COMPANION_SUFFIXES in
    // controls.ts's '-toronto-casing' suffix) rather than being its own Road
    // Layers radio choice — the user wants one "Traffic Volume (AADT)"
    // toggle to render both MTO's provincial data and this Toronto-local
    // data together. Same dark-underlay-casing trick as aadt-casing.
    //
    // No `filter` here (unlike an earlier version) — scripts/fetch_aadt_toronto.py
    // now PURGES everything below Minor Arterial at fetch time (see its
    // IMPORTANT_ROAD_CLASSES), so every feature in this tileset already
    // qualifies; a client-side filter would just be dead weight repeating
    // work already done in the data.
    //
    // line-opacity matches aadt-toronto's own opacity below (a companion
    // layer sharing the same source needs the same visual treatment).
    id: 'aadt-toronto-casing',
    label: 'Toronto Traffic Volume (Local, Est.) casing',
    sourceId: 'aadt-toronto',
    source: { kind: 'vector', path: 'tiles/aadt_toronto.pmtiles', sourceLayer: 'aadt_toronto' },
    type: 'line',
    paint: {
      'line-color': '#333333',
      'line-width': zoomScaledWidth(3.5, 9),
      'line-opacity': ['case', ['get', 'is_measured'], 1, 0.55],
    },
    defaultVisible: false,
  },
  {
    // Toronto's own local street counts (scripts/fetch_aadt_toronto.py),
    // estimated via the FHWA "Short Term Count ADT to AADT Conversion"
    // method from the City's public short-term SVC counts — MTO's own
    // aadt.geojson barely covers city streets, so this fills that gap.
    // Unlike aadt's authoritative MTO number, every feature here is at best
    // a seasonally-adjusted ESTIMATE (see aadtTorontoPopup.ts, which is
    // explicit about that), and at worst an INTERPOLATED fill-in (is_measured
    // false — see fetch_aadt_toronto.py's propagate_estimates): a real SVC
    // count only exists on some blocks of a street, not every block, so
    // uncounted blocks inherit their nearest same-street neighbor's estimate
    // via TCL's own intersection topology, capped at MAX_PROPAGATION_HOPS —
    // this is what fixed a real reported issue (a screenshot showing the
    // old per-count-only rendering looking disconnected/"piecewise" along a
    // single street, because most blocks genuinely had no count of their own).
    //
    // The tileset itself is already purged to Minor Arterial and above (see
    // fetch_aadt_toronto.py's IMPORTANT_ROAD_CLASSES / fetch_tcl_segments) —
    // Collector was tried first and dropped: it's too close to Local in
    // practice for a genuinely useful "important road" cut (e.g. Barton
    // Ave's Collector-classed blocks carried similar volume to Local blocks
    // nearby). No client-side filter needed here anymore, unlike an earlier
    // version of this layer.
    //
    // line-opacity fades interpolated segments (0.55) relative to real
    // measurements (1.0) — a lightweight visual honesty cue alongside the
    // popup's own explicit disclosure, so a glance at the map already hints
    // at which lines are real counts vs. filled-in guesses.
    //
    // Uses MTO's own AADT_COLOR_STOPS ramp directly (via aadtLineColorRamp),
    // not a Toronto-specific calibration, so a given color means the same
    // volume range on both datasets — most Toronto segments land in MTO's
    // bottom 2-3 tiers as a result, since city-street volumes run well under
    // MTO's highway-scale buckets, an accepted trade-off for one consistent
    // legend over the merged layer.
    id: 'aadt-toronto',
    label: 'Toronto Traffic Volume (Local, Est.)',
    sourceId: 'aadt-toronto',
    source: { kind: 'vector', path: 'tiles/aadt_toronto.pmtiles', sourceLayer: 'aadt_toronto' },
    type: 'line',
    paint: {
      'line-color': aadtLineColorRamp('aadt_estimate'),
      'line-width': zoomScaledWidth(2, 7),
      'line-opacity': ['case', ['get', 'is_measured'], 1, 0.55],
    },
    defaultVisible: false,
  },
  {
    // Sourced from NRCan's public ZEVIP "Charging_CorridorV2" ArcGIS
    // MapServer (scripts/fetch_zevip_corridor.py) — this service's own
    // /query endpoint never returns geometry (confirmed extensively: every
    // SR, GET/POST, quantized, even f=pbf turned out to be plain JSON
    // mislabeled with a protobuf content-type), and its /FeatureServer alias
    // is a broken ArcGIS Web Adaptor error page. /identify is the one
    // operation that DOES return real geometry, so the fetch script sweeps
    // it across a grid of bbox tiles and dedupes by OBJECTID.
    //
    // That dedup collapses NRCan's own duplicate records for the same
    // physical road under multiple overlapping named corridor designations —
    // confirmed real (large clusters of records sharing identical
    // Corridor_Score/demand/capacity values down to the decimal, per NRCan's
    // own user guide: corridors include "the National Highway System and
    // select other long-distance inter-community roads ... identified in
    // collaboration with provinces and territories", so the same road can
    // carry more than one designation). One line per physical road is the
    // correct output for a map, not a data-loss bug — hence why this is
    // tiled from a grid sweep instead of a plain bbox query like every other
    // ArcGIS-sourced layer here.
    //
    // Three layers together (zone, casing, corridor), all toggled by one
    // radio option via the `-zone`/`-casing` companion suffixes in
    // controls.ts. Defined in bottom-to-top render order.
    //
    // zevip-corridor-zone is a REAL 1.6km buffer computed at build time
    // (scripts/fetch_zevip_corridor.py: shapely + pyproj, reprojected to
    // EPSG:3978 for accurate metric distance) — not NRCan's own buffer
    // polygon (layer 1 of the same MapServer), which is a union of
    // independent per-segment circular buffers rather than one continuous
    // buffer of the merged route, so it renders as a string of overlapping
    // circles at every segment join (visually confirmed). It's also not an
    // earlier version of this layer that approximated the buffer as a wide
    // translucent LINE with a zoom-interpolated pixel width — that broke
    // down at high zoom (pixel width caps out, so it stops tracking the real
    // 1.6km distance) and was expensive to render (many overlapping wide
    // alpha-blended strokes). The real, pre-dissolved polygon here fixes
    // both: correct to scale at every zoom since it's genuine geometry, one
    // flat shape so overlapping/near-duplicate parallel corridor lines don't
    // stack their opacity into a visibly darker patch, and far cheaper to
    // render (one simple polygon vs. thousands of wide line strokes).
    id: 'zevip-corridor-zone',
    label: 'ZEVIP Corridor Score zone',
    sourceId: 'zevip-corridor-zone',
    source: { kind: 'vector', path: 'tiles/zevip_zone.pmtiles', sourceLayer: 'zevip_zone' },
    type: 'fill',
    paint: {
      'fill-color': '#00bcd4',
      'fill-opacity': 0.18,
    },
    defaultVisible: false,
  },
  {
    // Dark casing under the score line for contrast/visibility, same trick
    // and same reasoning as aadt-casing.
    id: 'zevip-corridor-casing',
    label: 'ZEVIP Corridor Score casing',
    sourceId: 'zevip-corridor',
    source: { kind: 'vector', path: 'tiles/zevip_corridor.pmtiles', sourceLayer: 'zevip_corridor' },
    type: 'line',
    paint: {
      'line-color': '#333333',
      'line-width': zoomScaledWidth(4, 11),
    },
    defaultVisible: false,
  },
  {
    // Colors match this app's AADT ramp exactly (same magenta/pink/plum
    // family, just 5 steps instead of 10 since corridor_score is already a
    // 1-5 categorical rating, not a continuous value needing finer buckets)
    // rather than NRCan's own green-to-red legend — deliberately consistent
    // with the AADT road layer next to it in the sidebar, since both are
    // "Road Layers" now.
    id: 'zevip-corridor',
    label: 'ZEVIP Corridor Score',
    sourceId: 'zevip-corridor',
    source: { kind: 'vector', path: 'tiles/zevip_corridor.pmtiles', sourceLayer: 'zevip_corridor' },
    type: 'line',
    paint: {
      'line-color': [
        'match',
        ['get', 'corridor_score'],
        1, '#fdeaf3', // Low
        2, '#f28fc0', // Medium Low
        3, '#d84f92', // Medium
        4, '#9c2f68', // Medium High
        5, '#591a3d', // High
        /* fallback */ '#999999',
      ],
      'line-width': zoomScaledWidth(2.5, 8),
    },
    defaultVisible: false,
  },
  {
    // One shared layer, not split by type — a station can have more than one
    // port type simultaneously (79 of 4756 Ontario stations have both L2 and
    // DCFC), so charger type is a filter-menu concern (src/evChargerFilters.ts,
    // ANDed onto this layer via map.setFilter), not separate map layers.
    // Color follows a priority order (DCFC > L2 > L1) since a dual-capability
    // station still needs exactly one dot color.
    id: 'ev-chargers',
    label: 'EV Chargers',
    sourceId: 'ev-chargers',
    source: { kind: 'geojson', path: 'data/ev_chargers.geojson' },
    type: 'circle',
    paint: {
      'circle-color': ['case', ['get', 'has_dcfc'], '#1a4971', ['get', 'has_l2'], '#63b3ed', '#999999'],
      'circle-radius': ['interpolate', ['linear'], ['get', 'total_ports'], 1, 4, 6, 8, 20, 12, 60, 14],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1,
    },
    defaultVisible: true,
    minZoom: 10,
  },
  {
    // A symbol layer, not circle — the square distinguishes it at a glance
    // from ev-chargers' round markers. The icon itself is a plain generated
    // square (see createSquareIcon in main.ts), registered via map.addImage
    // before this layer is added, rather than a shipped asset file.
    id: 'gas-stations',
    label: 'Gas Stations',
    sourceId: 'gas-stations',
    source: { kind: 'geojson', path: 'data/gas_stations.geojson' },
    type: 'symbol',
    paint: {},
    layout: {
      'icon-image': 'gas-station-square',
      'icon-size': 1,
      // Matches circle layers' behavior of always rendering every point —
      // symbol layers, unlike circle, hide markers that collide with each
      // other or with other symbols (e.g. LDC territory labels) by default.
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    defaultVisible: false,
    minZoom: 10, // matches ev-chargers, so both appear at the same zoom level
  },
  {
    // Defined last so it's the topmost static layer by default add-order —
    // main.ts also explicitly calls map.moveLayer('ldc-territories') after
    // every layer (including the live parking-lots layer) is added, so this
    // stays topmost regardless of future reordering here.
    id: 'ldc-territories',
    label: 'LDC Territory Boundaries',
    sourceId: 'ldc-territories',
    // Pre-tiled via tippecanoe — only 25 features, but dense enough polygons
    // to come to 4.93MB as plain GeoJSON (~9.7x down to ~0.51MB pmtiles).
    source: { kind: 'vector', path: 'tiles/ldc_territories.pmtiles', sourceLayer: 'ldc_territories' },
    type: 'line',
    paint: {
      'line-color': '#555555',
      'line-width': 1.5,
    },
    defaultVisible: true,
  },
];
