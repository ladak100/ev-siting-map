import 'maplibre-gl/dist/maplibre-gl.css';
import { Map as MapLibreMap, addProtocol } from 'maplibre-gl';
import { Protocol as PMTilesProtocol } from 'pmtiles';
import { layerConfigs } from './layers';
import { attachPopup, initClickDispatcher } from './popups';
import { renderEvAdoptionPopup } from './evAdoptionPopup';
import { renderEvChargerPopup } from './evChargerPopup';
import { initEvChargerFilters } from './evChargerFilters';
import { initCustomOverlayFilters } from './customOverlayFilters';
import { initSidebarToggle, initLayerCheckboxes, initAreaOverviewRadios } from './controls';

const pmtilesProtocol = new PMTilesProtocol();
addProtocol('pmtiles', pmtilesProtocol.tile);

const GGH_CENTER: [number, number] = [-79.38, 43.85];
const GGH_ZOOM = 8;

// A feeder polygon's unique key in the tiled load-capacity data (see
// scripts/fetch_load_capacity_raw.py's outFields). Used to filter the
// selection-highlight layer to just the clicked feature.
const FEEDER_ID_FIELD = 'idldc';
// An FSA polygon's unique key in ev_adoption.geojson (StatsCan's CFSA boundary field).
const FSA_ID_FIELD = 'CFSAUID';
const NO_SELECTION = ' __none-selected__';

// The Area Overview choropleths that share the ev_adoption.geojson source (see layers.ts) —
// same underlying FSA features, so they all get the same rich popup regardless of which is active.
const FSA_LAYER_IDS = ['ev-adoption-pct', 'ev-adoption-total', 'ev-adoption-housing', 'household-income'];

const map = new MapLibreMap({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty', // more visible roads than Positron, which is deliberately muted for overlay data
  center: GGH_CENTER,
  zoom: GGH_ZOOM,
  // MapLibre's own default only auto-collapses attribution below 640px
  // viewport width, staying expanded above that — forcing compact here
  // instead makes it deterministic (and keeps the legend's clearance,
  // tracked via ResizeObserver below, smaller and more stable).
  attributionControl: { compact: true },
});

map.on('load', () => {
  map.addImage('gas-station-square', createSquareIcon(8, 2, '#333333'));
  addStaticLayers();
  initClickDispatcher(map);

  // LDC territories are the topmost layer by requirement — move it above everything else.
  map.moveLayer('ldc-territories');

  initSidebarToggle();
  initLayerCheckboxes(map);
  initAreaOverviewRadios(map);
  initLegendAttributionSpacing(map);
  initEvChargerFilters(map, resolveAssetUrl('data/ev_chargers.geojson'));
  initCustomOverlayFilters(map, resolveAssetUrl('data/custom_overlay_histograms.json'));
});

// The legend and MapLibre's own attribution control share the bottom-right
// corner. The attribution control can grow taller (e.g. its "(i)" button
// expands to show full attribution text), and a fixed CSS offset can't
// account for that — so this tracks its ACTUAL rendered height via
// ResizeObserver and keeps the legend's bottom offset in sync, regardless of
// why or how the attribution control's size changed.
function initLegendAttributionSpacing(map: MapLibreMap): void {
  const GAP_PX = 6;
  const legend = document.getElementById('map-legend');
  const attribution = map.getContainer().querySelector<HTMLElement>('.maplibregl-ctrl-bottom-right');
  if (!legend || !attribution) return;

  const updateSpacing = () => {
    legend.style.bottom = `${attribution.getBoundingClientRect().height + GAP_PX}px`;
  };

  new ResizeObserver(updateSpacing).observe(attribution);
  updateSpacing();
}

// Vite serves/builds everything under `base` (e.g. '/ev-siting-map/'), so
// asset paths must be resolved against BASE_URL rather than the domain root —
// a hardcoded '/data/x.geojson' 404s once deployed under a repo subpath.
function resolveAssetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path}`;
}

// A plain solid-color rounded square, generated on the fly rather than
// shipped as an image asset — gas stations only ever need this one flat
// color, so a canvas draw is simpler than managing a static file.
function createSquareIcon(size: number, radius: number, color: string): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, radius);
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

function addStaticLayers(): void {
  const addedSources = new Set<string>();

  for (const config of layerConfigs) {
    if (!addedSources.has(config.sourceId)) {
      if (config.source.kind === 'geojson') {
        map.addSource(config.sourceId, {
          type: 'geojson',
          data: resolveAssetUrl(config.source.path),
        });
      } else {
        map.addSource(config.sourceId, {
          type: 'vector',
          url: `pmtiles://${resolveAssetUrl(config.source.path)}`,
        });
      }
      addedSources.add(config.sourceId);
    }

    map.addLayer({
      id: config.id,
      type: config.type,
      source: config.sourceId,
      paint: config.paint,
      layout: {
        visibility: config.defaultVisible ? 'visible' : 'none',
        ...config.layout,
      },
      minzoom: config.minZoom ?? 0,
      // Only include these when they have real values — MapLibre's style
      // validator rejects a layer outright if the key is *present* with an
      // undefined value (silently: addLayer fires an 'error' event rather
      // than throwing, so the layer just never gets added).
      ...(config.source.kind === 'vector' ? { 'source-layer': config.source.sourceLayer } : {}),
      ...(config.filter ? { filter: config.filter } : {}),
    } as never);

    if (config.id === 'ldc-territories' || config.id === 'parking-lots' || config.id === 'custom-overlay') {
      // Context layers, not interactive targets — no popup.
    } else if (config.id === 'load-capacity') {
      attachPopup(map, config.id, {
        onSelect: (feature) => selectFeeder(feature.properties?.[FEEDER_ID_FIELD]),
        onDeselect: () => selectFeeder(undefined),
      });
    } else if (FSA_LAYER_IDS.includes(config.id)) {
      // All four share the same underlying feature data (see layers.ts) —
      // whichever one is currently visible should show the same popup+chart
      // and the same border highlight.
      attachPopup(map, config.id, {
        renderHTML: renderEvAdoptionPopup,
        onSelect: (feature) => selectFsa(feature.properties?.[FSA_ID_FIELD]),
        onDeselect: () => selectFsa(undefined),
      });
    } else if (config.id === 'ev-chargers') {
      attachPopup(map, config.id, { renderHTML: renderEvChargerPopup });
    } else {
      attachPopup(map, config.id);
    }
  }

  addLdcLabels();
  addLoadCapacityHighlight();
  addFsaHighlight();
}

function addLdcLabels(): void {
  map.addLayer({
    id: 'ldc-territories-labels',
    type: 'symbol',
    source: 'ldc-territories',
    'source-layer': 'ldc_territories',
    layout: {
      'text-field': ['get', 'LDC_Name_12'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 11,
      'symbol-placement': 'point',
      'text-allow-overlap': false,
      visibility: 'visible', // kept in sync with the ldc-territories checkbox, see controls.ts
    },
    paint: {
      'text-color': '#333333',
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.2,
    },
  } as never);
}

// "Pop out" the clicked feeder: a white casing + dark line on top, filtered to
// just that feature's FEEDER_ID_FIELD. Two stacked lines read as a clear
// selection outline regardless of the status color underneath, unlike a
// single-color line which can wash out against similarly-dark fills.
function addLoadCapacityHighlight(): void {
  const noSelectionFilter = ['==', ['get', FEEDER_ID_FIELD], NO_SELECTION];

  map.addLayer({
    id: 'load-capacity-highlight-casing',
    type: 'line',
    source: 'load-capacity',
    'source-layer': 'load_capacity',
    paint: { 'line-color': '#ffffff', 'line-width': 4.5 },
    filter: noSelectionFilter,
  } as never);

  map.addLayer({
    id: 'load-capacity-highlight',
    type: 'line',
    source: 'load-capacity',
    'source-layer': 'load_capacity',
    paint: { 'line-color': '#1a1a1a', 'line-width': 2 },
    filter: noSelectionFilter,
  } as never);
}

function selectFeeder(feederId: unknown): void {
  const filter = ['==', ['get', FEEDER_ID_FIELD], typeof feederId === 'string' ? feederId : NO_SELECTION] as never;
  map.setFilter('load-capacity-highlight-casing', filter);
  map.setFilter('load-capacity-highlight', filter);
}

// Same "pop out" treatment as load-capacity, but for whichever FSA layer is
// currently active (they share one source — see layers.ts — so one highlight
// pair covers all four).
function addFsaHighlight(): void {
  const noSelectionFilter = ['==', ['get', FSA_ID_FIELD], NO_SELECTION];

  map.addLayer({
    id: 'fsa-highlight-casing',
    type: 'line',
    source: 'ev-adoption',
    'source-layer': 'ev_adoption',
    paint: { 'line-color': '#ffffff', 'line-width': 4.5 },
    filter: noSelectionFilter,
  } as never);

  map.addLayer({
    id: 'fsa-highlight',
    type: 'line',
    source: 'ev-adoption',
    'source-layer': 'ev_adoption',
    paint: { 'line-color': '#1a1a1a', 'line-width': 2 },
    filter: noSelectionFilter,
  } as never);
}

function selectFsa(fsaCode: unknown): void {
  const filter = ['==', ['get', FSA_ID_FIELD], typeof fsaCode === 'string' ? fsaCode : NO_SELECTION] as never;
  map.setFilter('fsa-highlight-casing', filter);
  map.setFilter('fsa-highlight', filter);
}

