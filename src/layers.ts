export type LayerType = 'fill' | 'line' | 'circle';

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
  /** MapLibre filter expression, for layers that split a shared source */
  filter?: unknown[];
  defaultVisible: boolean;
  minZoom?: number;
}

// NOTE: every layer below is confirmed against real data — see
// scripts/fetch_ccim.py, scripts/fetch_load_capacity_raw.py,
// scripts/fetch_ev_adoption.py, and scripts/extract_ev_chargers.py.

export const layerConfigs: LayerConfig[] = [
  {
    id: 'load-capacity',
    label: 'Available Load Capacity (MVA)',
    sourceId: 'load-capacity',
    // Pre-tiled via tippecanoe (scripts/fetch_load_capacity_raw.py -> tippecanoe),
    // not a live query and not a single baked GeoJSON: the full GGH dataset is
    // ~43k feeder polygons / ~100MB as GeoJSON, too large to bake or query
    // per-viewport reliably. The .pmtiles archive is ~11MB, self-hosted, no
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
    // ev-adoption-pct / ev-adoption-total / ev-adoption-housing share one
    // source (built by scripts/fetch_ev_adoption.py: StatsCan CFSA boundaries
    // + all historical Ontario MTO EV-by-FSA quarters + the committed census
    // dwellings extract — 334 FSA polygons) and are three separate Area
    // Overview radio choices, all sequential magnitudes so all three reuse
    // the same green hue (per the dataviz skill: a second hue is only needed
    // when two sequential contexts are visible AT ONCE — these are radio-
    // exclusive, never simultaneous), just calibrated to each metric's own
    // real range. fill-opacity zeroes out (transparent, not grey) wherever
    // the underlying value is null — e.g. the 3 near-zero-household
    // industrial FSAs the fetch script suppresses (see MIN_DWELLINGS_FOR_RATE).
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
    // Calibrated to this dataset's real spread (min 29, median 452, p90 1368, max 3382)
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
    // One shared layer, not split by type — a station can have more than one
    // port type simultaneously (39 of 2860 GGH stations have both L2 and
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
    defaultVisible: false,
    minZoom: 10,
  },
  {
    id: 'gas-stations',
    label: 'Gas Stations',
    sourceId: 'gas-stations',
    source: { kind: 'geojson', path: 'data/gas_stations.geojson' },
    type: 'circle',
    paint: {
      'circle-color': '#333333',
      'circle-radius': 5,
    },
    defaultVisible: false,
    minZoom: 10, // matches ev-chargers, so both appear at the same zoom level
  },
  {
    // Shares the ev-adoption source too (see the comment on ev-adoption-pct
    // above) — median_income comes from the same StatsCan Census Profile
    // pull as the dwelling data, just characteristic 243 instead. Originally
    // planned as a separate DA-level layer (id "income-da"), but since we'd
    // already built the FSA-level pipeline for EV adoption, extending that
    // was far less work than a whole separate DA-boundary join, and keeps
    // every Area Overview layer at the same FSA granularity.
    id: 'household-income',
    label: 'Household Income ($)',
    sourceId: 'ev-adoption',
    source: { kind: 'vector', path: 'tiles/ev_adoption.pmtiles', sourceLayer: 'ev_adoption' },
    type: 'fill',
    // Calibrated to this dataset's real spread (min $53.6k, median $92k, p90 $129k, max $198k)
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
    // Used to be a live per-viewport Overpass query (~59k GGH-wide polygons,
    // ~26MB raw — too big to bake as plain GeoJSON, same reasoning as
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
    defaultVisible: false,
    minZoom: 13,
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
