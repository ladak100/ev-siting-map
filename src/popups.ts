import type { Map as MapLibreMap, MapGeoJSONFeature } from 'maplibre-gl';
import { Popup } from 'maplibre-gl';

// Generic popup: dumps GeoJSON feature properties as a simple key/value list.
// Fine for scaffold; swap in per-layer formatting once real attribute schemas
// (from fetch_ccim.py, fetch_ev_chargers.py, etc.) are known.
function renderProperties(properties: Record<string, unknown> | null | undefined): string {
  if (!properties) return '';
  const rows = Object.entries(properties)
    .map(([key, value]) => `<tr><td><strong>${key}</strong></td><td>${String(value)}</td></tr>`)
    .join('');
  return `<table>${rows}</table>`;
}

interface AttachPopupOptions {
  /** Called with the clicked feature — e.g. to filter a highlight layer to it */
  onSelect?: (feature: MapGeoJSONFeature) => void;
  /** Called when the popup closes (click elsewhere, X button, or programmatic) */
  onDeselect?: () => void;
  /** Overrides the generic property-table dump — e.g. a chart for time-series data */
  renderHTML?: (feature: MapGeoJSONFeature) => string;
}

interface RegisteredLayer {
  layerId: string;
  options?: AttachPopupOptions;
}

const registeredLayers: RegisteredLayer[] = [];
let activePopup: Popup | undefined;
let activeLayerId: string | undefined;

/**
 * Registers `layerId` as clickable (popup and/or select/deselect callbacks).
 * Does NOT wire its own click listener — initClickDispatcher (call once,
 * after every attachPopup call) does ONE queryRenderedFeatures per click and
 * dispatches only to whichever REGISTERED layer is topmost at that point.
 *
 * This matters because layers overlap: a charger pin can sit visually on top
 * of a load-capacity polygon, and MapLibre's per-layer `map.on('click',
 * layerId, cb)` hit-tests each registered layer independently — so clicking
 * the pin used to ALSO fire the polygon's handler underneath (its popup just
 * got hidden behind the charger's popup, but its highlight still applied).
 * Querying once and taking the topmost hit avoids that entirely.
 */
export function attachPopup(map: MapLibreMap, layerId: string, options?: AttachPopupOptions): void {
  registeredLayers.push({ layerId, options });

  map.on('mouseenter', layerId, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', layerId, () => {
    map.getCanvas().style.cursor = '';
  });
}

function close(): void {
  if (!activePopup) return;
  const popup = activePopup;
  const layerId = activeLayerId;
  activePopup = undefined;
  activeLayerId = undefined;
  popup.remove();
  registeredLayers.find((r) => r.layerId === layerId)?.options?.onDeselect?.();
}

/** Call once, after every attachPopup registration, to wire the shared click dispatcher. */
export function initClickDispatcher(map: MapLibreMap): void {
  map.on('click', (e) => {
    const layerIds = registeredLayers.map((r) => r.layerId).filter((id) => map.getLayer(id));
    const topHit = layerIds.length > 0 ? map.queryRenderedFeatures(e.point, { layers: layerIds })[0] : undefined;

    const reg = topHit && registeredLayers.find((r) => r.layerId === topHit.layer.id);
    if (!topHit || !reg) {
      close();
      return;
    }

    close();

    reg.options?.onSelect?.(topHit);

    const html = reg.options?.renderHTML ? reg.options.renderHTML(topHit) : renderProperties(topHit.properties);
    activePopup = new Popup({ closeOnClick: false }).setLngLat(e.lngLat).setHTML(html).addTo(map);
    activeLayerId = reg.layerId;

    activePopup.on('close', () => {
      // Fires for the native X button too. The `activePopup` guard skips a
      // second onDeselect call when this fires as a side effect of our own
      // close() above (which already cleared activePopup and called it once).
      if (activePopup) {
        const closingLayerId = activeLayerId;
        activePopup = undefined;
        activeLayerId = undefined;
        registeredLayers.find((r) => r.layerId === closingLayerId)?.options?.onDeselect?.();
      }
    });
  });
}
