import type { Map as MapLibreMap } from 'maplibre-gl';

const LAYER_ID = 'ev-chargers';
const CHARGER_TYPES = ['l2', 'dcfc'] as const; // L1 excluded — exactly 1 GGH station has any L1 ports, not worth a filter row
type ChargerType = (typeof CHARGER_TYPES)[number];

// "Tesla" (the raw network value, used for both filtering and the popup) is
// specifically Tesla's Supercharger network (confirmed: 100% DCFC in this
// data) — display-only relabel so the filter list reads unambiguously,
// without touching the underlying value anything actually filters/joins on.
export const NETWORK_DISPLAY_NAMES: Record<string, string> = {
  Tesla: 'Tesla Supercharger',
};

// Empty selection = no restriction (show everything) for both dimensions —
// checking specific values narrows down, rather than starting from
// "everything checked" and making the user un-check dozens of boxes.
const selectedTypes = new Set<ChargerType>();
const selectedNetworks = new Set<string>();

function computeFilter(): unknown {
  const parts: unknown[] = [];

  if (selectedTypes.size > 0) {
    parts.push(['any', ...Array.from(selectedTypes).map((t) => ['get', `has_${t}`])]);
  }
  if (selectedNetworks.size > 0) {
    parts.push(['in', ['get', 'network_group'], ['literal', Array.from(selectedNetworks)]]);
  }

  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0] : ['all', ...parts];
}

function applyFilter(map: MapLibreMap): void {
  map.setFilter(LAYER_ID, computeFilter() as never);
}

/**
 * Builds the combined charger-type + network filter accordion. Network
 * options come from the data itself (network_group, computed in
 * scripts/extract_ev_chargers.py) rather than a hardcoded list, so they
 * can't drift out of sync with what's actually in data/ev_chargers.geojson.
 */
export async function initEvChargerFilters(map: MapLibreMap, geojsonUrl: string): Promise<void> {
  const toggle = document.getElementById('ev-charger-filter-toggle');
  const panel = document.getElementById('ev-charger-filter-panel');
  const networkContainer = document.getElementById('network-filter-options');
  if (!toggle || !panel || !networkContainer) return;

  panel.querySelectorAll<HTMLInputElement>('input[data-charger-type]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const type = checkbox.dataset.chargerType as ChargerType;
      if (checkbox.checked) selectedTypes.add(type);
      else selectedTypes.delete(type);
      applyFilter(map);
    });
  });

  const response = await fetch(geojsonUrl);
  const data = (await response.json()) as { features: { properties: { network_group?: string } }[] };

  const counts = new Map<string, number>();
  for (const feature of data.features) {
    const group = feature.properties.network_group || 'Other';
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  // "Other" last regardless of its count — it's a catch-all, not a real network.
  const sorted = Array.from(counts.entries()).sort((a, b) => (a[0] === 'Other' ? 1 : b[0] === 'Other' ? -1 : b[1] - a[1]));

  networkContainer.innerHTML = sorted
    .map(([group, count]) => {
      const label = NETWORK_DISPLAY_NAMES[group] ?? group;
      return `<label><input type="checkbox" value="${group}" /> ${label} <span class="network-count">${count}</span></label>`;
    })
    .join('');

  networkContainer.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedNetworks.add(checkbox.value);
      else selectedNetworks.delete(checkbox.value);
      applyFilter(map);
    });
  });

  // Plain accordion toggle — no "close on outside click": unlike a floating
  // popover, expanding this just pushes the rest of the sidebar down, so
  // there's nothing it visually covers that would motivate auto-closing.
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    panel.hidden = expanded;
  });
}
