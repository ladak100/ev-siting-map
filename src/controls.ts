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
 */
export function initSidebarToggle(): void {
  const app = document.getElementById('app');
  const toggle = document.getElementById('sidebar-toggle');
  if (!app || !toggle) return;

  function setCollapsed(collapsed: boolean): void {
    app!.classList.toggle('sidebar-collapsed', collapsed);
    toggle!.textContent = collapsed ? '›' : '‹';
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
function refreshMapLegendContainer(): void {
  const container = document.getElementById('map-legend');
  if (!container) return;
  const anyVisible = Array.from(container.children).some((el) => (el as HTMLElement).style.display !== 'none');
  container.style.display = anyVisible ? '' : 'none';
}

/**
 * Wires every sidebar checkbox to its map layer's visibility. Scoped to
 * type="checkbox" only — the mutually-exclusive "Area Overview" layers use
 * type="radio" instead (see initAreaOverviewRadios) and share the
 * data-layer-id attribute, so this selector must not pick them up too.
 *
 * A checkbox may have a companion legend block, `#legend-<layerId>`
 * (e.g. #legend-load-capacity), shown/hidden alongside it. It may also have
 * a companion map layer, `<layerId>-labels` (e.g. ldc-territories-labels),
 * toggled together since it's the same conceptual layer to the user.
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

    const labelsLayerId = `${layerId}-labels`;
    const setLayerVisibility = (visible: boolean) => {
      const visibility = visible ? 'visible' : 'none';
      map.setLayoutProperty(layerId, 'visibility', visibility);
      if (map.getLayer(labelsLayerId)) {
        map.setLayoutProperty(labelsLayerId, 'visibility', visibility);
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
