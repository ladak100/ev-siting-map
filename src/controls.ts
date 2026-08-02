import type { Map as MapLibreMap } from 'maplibre-gl';
import { layerConfigs } from './layers';

// Matches the CSS media query breakpoint that switches the sidebar from
// pushing the map (desktop) to overlaying it (mobile) — see style.css.
const MOBILE_BREAKPOINT_PX = 640;

/**
 * Wires the folder-tab toggle button. The collapsed state lives as a class
 * on #app (not #sidebar itself) so the button — a sibling of #sidebar, not
 * a child — can react to it via CSS without needing DOM access to #sidebar.
 * Defaults to collapsed on narrow viewports so mobile users see the map
 * first, not a full-width sidebar.
 *
 * The button's own icon (a ▾, shared with #map-legend-toggle) is rotated by
 * CSS purely off the .sidebar-collapsed class — see style.css's
 * `#sidebar-toggle .toggle-icon` rules — so there's no textContent swapping
 * here, just the class and the aria-label.
 */
export function initSidebarToggle(): void {
  const app = document.getElementById('app');
  const toggle = document.getElementById('sidebar-toggle');
  if (!app || !toggle) return;

  function setCollapsed(collapsed: boolean): void {
    app!.classList.toggle('sidebar-collapsed', collapsed);
    toggle!.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  }

  toggle.addEventListener('click', () => {
    setCollapsed(!app.classList.contains('sidebar-collapsed'));
  });

  setCollapsed(window.innerWidth < MOBILE_BREAKPOINT_PX);
}

// A layer id may have one or more companion map layers sharing the same
// underlying source, toggled together since they're the same conceptual
// layer to the user: `<layerId>-labels` (e.g. ldc-territories-labels),
// `<layerId>-casing` (a dark border rendered under the main line, e.g.
// aadt-casing), or `<layerId>-zone` (a wide translucent line rendered under
// everything else, e.g. zevip-corridor-zone). Shared by both the checkbox
// wiring below and the radio-group wiring further down.
//
// `-toronto`/`-toronto-casing` are a special case of the same mechanism:
// aadt-toronto and aadt-toronto-casing are a genuinely SEPARATE dataset
// (Toronto's own local street counts, see scripts/fetch_aadt_toronto.py),
// not a visual sub-part of the aadt layer the way a casing/label normally
// is — but riding along as companions of 'aadt' is exactly how the two
// datasets end up toggled by a single "Traffic Volume (AADT)" control
// instead of a second Road Layers radio option.
const COMPANION_SUFFIXES = ['-labels', '-casing', '-zone', '-toronto', '-toronto-casing'];

function setLayerAndCompanionsVisible(map: MapLibreMap, layerId: string, visible: boolean): void {
  const visibility = visible ? 'visible' : 'none';
  map.setLayoutProperty(layerId, 'visibility', visibility);
  for (const suffix of COMPANION_SUFFIXES) {
    const companionId = `${layerId}${suffix}`;
    if (map.getLayer(companionId)) {
      map.setLayoutProperty(companionId, 'visibility', visibility);
    }
  }
}

// Every active layer gets its own titled block in the floating #map-legend
// card (see index.html), independently shown/hidden based on that layer's
// own visibility — so e.g. LDC boundaries + EV chargers + Gas Stations can
// all be listed together whenever their checkboxes are checked, not just
// the single active Fill Layers choice.
function setLegendBlockVisible(layerId: string, visible: boolean): void {
  const block = document.getElementById(`legend-${layerId}`);
  // Explicit 'block', not '' — the CSS default is `display: none` (to avoid
  // a flash of every legend before JS runs), so clearing the inline style
  // would just fall back to that same "none" instead of showing it.
  if (block) block.style.display = visible ? 'block' : 'none';
  refreshMapLegendContainer();
}

// Hides the whole floating card when it would otherwise render as an empty box.
// Queries .legend-block descendants generally (not direct children) since
// they live inside #map-legend-content, not #map-legend itself — see
// initLegendToggle.
function refreshMapLegendContainer(): void {
  const container = document.getElementById('map-legend');
  if (!container) return;
  const blocks = container.querySelectorAll<HTMLElement>('.legend-block');
  const anyVisible = Array.from(blocks).some((el) => el.style.display !== 'none');
  container.style.display = anyVisible ? '' : 'none';
}

/**
 * Wires the toggle in #map-legend-header to collapse/expand
 * #map-legend-content — same collapsible-card idea as the sidebar toggle
 * (initSidebarToggle above) and the same shared ▾ icon, just rotated onto
 * the vertical axis instead of horizontal (see style.css). Defaults to
 * expanded; purely a per-session UI preference, not persisted.
 */
export function initLegendToggle(): void {
  const legend = document.getElementById('map-legend');
  const toggle = document.getElementById('map-legend-toggle');
  if (!legend || !toggle) return;

  function setCollapsed(collapsed: boolean): void {
    legend!.classList.toggle('legend-collapsed', collapsed);
    toggle!.setAttribute('aria-expanded', String(!collapsed));
    toggle!.setAttribute('aria-label', collapsed ? 'Expand legend' : 'Collapse legend');
  }

  toggle.addEventListener('click', () => {
    setCollapsed(!legend.classList.contains('legend-collapsed'));
  });
}

/**
 * Wires every sidebar checkbox to its map layer's visibility. Scoped to
 * type="checkbox" only — the mutually-exclusive "Fill Layers" and "Road
 * Layers" groups use type="radio" instead (see initRadioGroup) and share the
 * data-layer-id attribute, so this selector must not pick them up too.
 *
 * A checkbox may have a companion legend block, `#legend-<layerId>`
 * (e.g. #legend-load-capacity), shown/hidden alongside it, plus whatever
 * companion map layers setLayerAndCompanionsVisible already handles.
 */
export function initLayerCheckboxes(map: MapLibreMap): void {
  const checkboxes = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-layer-id]');

  checkboxes.forEach((checkbox) => {
    const layerId = checkbox.dataset.layerId;
    if (!layerId) return;

    const config = layerConfigs.find((l) => l.id === layerId);
    if (!config) {
      console.warn(`No layer config found for checkbox "${layerId}"`);
      return;
    }

    checkbox.checked = config.defaultVisible;
    setLegendBlockVisible(layerId, config.defaultVisible);
    if (layerId === 'ev-chargers') setFilterToggleEnabled('ev-charger-filter-toggle', 'ev-charger-filter-panel', config.defaultVisible);

    checkbox.addEventListener('change', () => {
      setLayerAndCompanionsVisible(map, layerId, checkbox.checked);
      setLegendBlockVisible(layerId, checkbox.checked);
      if (layerId === 'ev-chargers') setFilterToggleEnabled('ev-charger-filter-toggle', 'ev-charger-filter-panel', checkbox.checked);
    });
  });
}

/**
 * Shared by both radio groups below (Fill Layers, Road Layers): wires every
 * `input[type="radio"][name="{groupName}"]` so exactly one (or none, via a
 * "None" option with no data-layer-id) of `layerIds` is visible at a time,
 * including each one's companion layers/legend block. `onSelectionChange`
 * lets a specific group react further (e.g. Fill Layers' Custom filter
 * toggle).
 */
function initRadioGroup(map: MapLibreMap, groupName: string, layerIds: string[], onSelectionChange?: (selectedLayerId: string | undefined) => void): void {
  const radios = document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${groupName}"]`);

  function applySelection(selectedLayerId: string | undefined): void {
    for (const layerId of layerIds) {
      const visible = layerId === selectedLayerId;
      setLayerAndCompanionsVisible(map, layerId, visible);
      setLegendBlockVisible(layerId, visible);
    }
    onSelectionChange?.(selectedLayerId);
  }

  radios.forEach((radio) => {
    radio.addEventListener('change', () => {
      if (radio.checked) applySelection(radio.dataset.layerId);
    });
  });

  const initial = document.querySelector<HTMLInputElement>(`input[type="radio"][name="${groupName}"]:checked`);
  applySelection(initial?.dataset.layerId);
}

/**
 * The "Fill Layers" fieldset (load-capacity, the ev-adoption layers,
 * household-income) are all semi-transparent polygon-fill choropleths —
 * showing more than one at once blends into unreadable colors, and they're
 * drawn at incompatible granularities (feeders vs. FSAs) anyway. So unlike
 * other layers, these are wired as a single radio group: exactly one (or
 * none) visible.
 */
const FILL_LAYER_IDS = ['load-capacity', 'ev-adoption-pct', 'ev-adoption-total', 'ev-adoption-housing', 'household-income', 'custom-overlay'];

export function initFillLayerRadios(map: MapLibreMap): void {
  initRadioGroup(map, 'fill-layers', FILL_LAYER_IDS, (selectedLayerId) => {
    setFilterToggleEnabled('custom-overlay-filter-toggle', 'custom-overlay-filter-panel', selectedLayerId === 'custom-overlay');
  });
}

/**
 * The "Road Layers" fieldset (AADT, ZEVIP Corridor Score) are both full-
 * network road-line overlays with their own busy color ramps — showing both
 * at once would be visually competing, so like Fill Layers these are a
 * single radio group instead of independent checkboxes.
 */
const ROAD_LAYER_IDS = ['aadt', 'zevip-corridor'];

export function initRoadLayerRadios(map: MapLibreMap): void {
  initRadioGroup(map, 'road-layers', ROAD_LAYER_IDS);
}

// A filter accordion only means anything while its own layer is actually
// showing — EV Chargers unchecked, or a different Fill Layers radio
// picked, both leave the filter adjusting a layer that isn't drawn. Disabling
// the button (rather than leaving it clickable but inert) makes that
// dependency visible instead of letting the user fiddle with filters for a
// hidden layer and wonder why nothing happens. Also collapses the panel if
// it was left open when the user switches away, so it doesn't linger
// open-but-unusable.
function setFilterToggleEnabled(toggleId: string, panelId: string, enabled: boolean): void {
  const toggle = document.getElementById(toggleId) as HTMLButtonElement | null;
  const panel = document.getElementById(panelId);
  if (!toggle) return;

  toggle.disabled = !enabled;
  if (!enabled && panel && !panel.hidden) {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  }
}
