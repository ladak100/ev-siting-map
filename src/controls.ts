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

// Every active layer gets its own titled block in the floating #map-legend
// card (see index.html), independently shown/hidden based on that layer's
// own visibility — so e.g. LDC boundaries + EV chargers + Gas Stations can
// all be listed together whenever their checkboxes are checked, not just
// the single active Area Overview choice.
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
 * type="checkbox" only — the mutually-exclusive "Area Overview" layers use
 * type="radio" instead (see initAreaOverviewRadios) and share the
 * data-layer-id attribute, so this selector must not pick them up too.
 *
 * A checkbox may have a companion legend block, `#legend-<layerId>`
 * (e.g. #legend-load-capacity), shown/hidden alongside it. It may also have
 * one or more companion map layers — `<layerId>-labels` (e.g.
 * ldc-territories-labels) or `<layerId>-casing` (e.g. aadt-casing, the dark
 * border rendered under the aadt line) — toggled together since they're the
 * same conceptual layer to the user.
 */
export function initLayerCheckboxes(map: MapLibreMap): void {
  const checkboxes = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-layer-id]');
  const COMPANION_SUFFIXES = ['-labels', '-casing'];

  checkboxes.forEach((checkbox) => {
    const layerId = checkbox.dataset.layerId;
    if (!layerId) return;

    const config = layerConfigs.find((l) => l.id === layerId);
    if (!config) {
      console.warn(`No layer config found for checkbox "${layerId}"`);
      return;
    }

    const companionLayerIds = COMPANION_SUFFIXES.map((suffix) => `${layerId}${suffix}`);
    const setLayerVisibility = (visible: boolean) => {
      const visibility = visible ? 'visible' : 'none';
      map.setLayoutProperty(layerId, 'visibility', visibility);
      for (const companionId of companionLayerIds) {
        if (map.getLayer(companionId)) {
          map.setLayoutProperty(companionId, 'visibility', visibility);
        }
      }
    };

    checkbox.checked = config.defaultVisible;
    setLegendBlockVisible(layerId, config.defaultVisible);
    if (layerId === 'ev-chargers') setFilterToggleEnabled('ev-charger-filter-toggle', 'ev-charger-filter-panel', config.defaultVisible);

    checkbox.addEventListener('change', () => {
      setLayerVisibility(checkbox.checked);
      setLegendBlockVisible(layerId, checkbox.checked);
      if (layerId === 'ev-chargers') setFilterToggleEnabled('ev-charger-filter-toggle', 'ev-charger-filter-panel', checkbox.checked);
    });
  });
}

/**
 * The "Area Overview" fieldset (load-capacity, the ev-adoption layers,
 * household-income) are all semi-transparent polygon-fill choropleths —
 * showing more than one at once blends into unreadable colors, and they're
 * drawn at incompatible granularities (feeders vs. FSAs) anyway. So unlike
 * other layers, these are wired as a single radio group: exactly one (or
 * none) visible.
 */
const AREA_OVERVIEW_LAYER_IDS = ['load-capacity', 'ev-adoption-pct', 'ev-adoption-total', 'ev-adoption-housing', 'household-income', 'custom-overlay'];

export function initAreaOverviewRadios(map: MapLibreMap): void {
  const radios = document.querySelectorAll<HTMLInputElement>('input[type="radio"][name="area-overview"]');

  function applySelection(selectedLayerId: string | undefined): void {
    for (const layerId of AREA_OVERVIEW_LAYER_IDS) {
      const visible = layerId === selectedLayerId;
      map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
      setLegendBlockVisible(layerId, visible);
    }
    setFilterToggleEnabled('custom-overlay-filter-toggle', 'custom-overlay-filter-panel', selectedLayerId === 'custom-overlay');
  }

  radios.forEach((radio) => {
    radio.addEventListener('change', () => {
      if (radio.checked) applySelection(radio.dataset.layerId);
    });
  });

  const initial = document.querySelector<HTMLInputElement>('input[type="radio"][name="area-overview"]:checked');
  applySelection(initial?.dataset.layerId);
}

// A filter accordion only means anything while its own layer is actually
// showing — EV Chargers unchecked, or a different Area Overview radio
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
