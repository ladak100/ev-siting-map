import type { Map as MapLibreMap } from 'maplibre-gl';

const LAYER_ID = 'custom-overlay';

// Must match the properties scripts/build_custom_overlay.py stamps onto every
// split polygon, and the data-slider-field values in index.html.
const SLIDER_FIELDS = ['capacity', 'ev_adoption_pct', 'total_ev', 'houses_pct', 'median_income'] as const;
type SliderField = (typeof SLIDER_FIELDS)[number];

interface HistogramBins {
  min: number;
  max: number;
  counts: number[];
}
type Histograms = Partial<Record<SliderField, HistogramBins>>;

// Each field's own header already names its unit ("Load Capacity (MVA)",
// "EV Adoption (%)") — repeating it in the value-range text underneath just
// burns width in an already-narrow panel, see style.css's note on why the
// header/value stack rather than share a row.
function formatValue(field: SliderField, value: number): string {
  switch (field) {
    case 'median_income':
    case 'total_ev':
      return Math.round(value).toLocaleString();
    case 'ev_adoption_pct':
    case 'houses_pct':
      return value.toFixed(1);
    case 'capacity':
      return value.toFixed(1);
  }
}

// A feature missing this property entirely — e.g. a feeder with no reported
// capacity, or an FSA the fetch script suppressed for too few dwellings (see
// MIN_DWELLINGS_FOR_RATE in fetch_ev_adoption.py) — isn't disqualified by a
// constraint it has no data for. It passes this one condition regardless of
// where the slider sits, same "missing data isn't a hard no" reasoning the
// choropleth layers already use (their null-guarded fill-opacity).
function fieldCondition(field: SliderField, min: number, max: number): unknown {
  return ['any', ['==', ['get', field], null], ['all', ['>=', ['get', field], min], ['<=', ['get', field], max]]];
}

function computeFilter(panel: HTMLElement): unknown {
  const conditions = SLIDER_FIELDS.map((field) => {
    const wrapper = panel.querySelector<HTMLElement>(`[data-slider-field="${field}"]`);
    const minInput = wrapper?.querySelector<HTMLInputElement>('input[data-role="min"]');
    const maxInput = wrapper?.querySelector<HTMLInputElement>('input[data-role="max"]');
    return fieldCondition(field, Number(minInput?.value), Number(maxInput?.value));
  });
  return ['all', ...conditions];
}

// Matches .slider-histogram's CSS height exactly — pixel heights here
// instead of percentages, so there's no dependency on how a browser resolves
// a percentage height on a flex item (an edge case with a history of
// inconsistent behavior across engines; a fixed container height plus a
// fixed pixel scale sidesteps the question entirely).
const HISTOGRAM_HEIGHT_PX = 14;

function renderHistogram(container: HTMLElement, bins: HistogramBins): HTMLElement[] {
  const maxCount = Math.max(...bins.counts, 1);
  container.innerHTML = '';
  return bins.counts.map((count) => {
    const bar = document.createElement('div');
    bar.className = 'histogram-bar';
    const px = count > 0 ? Math.max((count / maxCount) * HISTOGRAM_HEIGHT_PX, 2) : 0;
    bar.style.height = `${px}px`;
    container.appendChild(bar);
    return bar;
  });
}

function initSliderField(map: MapLibreMap, panel: HTMLElement, field: SliderField, histogram: HistogramBins | undefined): void {
  const wrapper = panel.querySelector<HTMLElement>(`[data-slider-field="${field}"]`);
  const minInput = wrapper?.querySelector<HTMLInputElement>('input[data-role="min"]');
  const maxInput = wrapper?.querySelector<HTMLInputElement>('input[data-role="max"]');
  const minLabel = wrapper?.querySelector<HTMLElement>('[data-role="min-label"]');
  const maxLabel = wrapper?.querySelector<HTMLElement>('[data-role="max-label"]');
  const fill = wrapper?.querySelector<HTMLElement>('.dual-range-fill');
  const histogramContainer = wrapper?.querySelector<HTMLElement>('.slider-histogram');
  if (!wrapper || !minInput || !maxInput || !minLabel || !maxLabel || !fill || !histogramContainer) return;

  const rangeLo = Number(minInput.min);
  const rangeHi = Number(minInput.max);
  const bars = histogram ? renderHistogram(histogramContainer, histogram) : [];
  const binWidth = histogram ? (histogram.max - histogram.min) / histogram.counts.length : 0;

  function refresh(justMoved: HTMLInputElement): void {
    // Keep the two thumbs from crossing — push the other handle along with
    // whichever one the user is actively dragging, rather than letting min
    // end up above max.
    if (Number(minInput!.value) > Number(maxInput!.value)) {
      if (justMoved === minInput) maxInput!.value = minInput!.value;
      else minInput!.value = maxInput!.value;
    }

    const minVal = Number(minInput!.value);
    const maxVal = Number(maxInput!.value);
    minLabel!.textContent = formatValue(field, minVal);
    maxLabel!.textContent = formatValue(field, maxVal);

    const pctMin = ((minVal - rangeLo) / (rangeHi - rangeLo)) * 100;
    const pctMax = ((maxVal - rangeLo) / (rangeHi - rangeLo)) * 100;
    fill!.style.left = `${pctMin}%`;
    fill!.style.width = `${pctMax - pctMin}%`;

    // Shows "how much is left on the table" directly on the histogram: bars
    // whose bin falls outside the currently selected range mute to grey,
    // bars inside stay the "valid" orange.
    if (histogram) {
      bars.forEach((bar, i) => {
        const binCenter = histogram.min + binWidth * (i + 0.5);
        bar.classList.toggle('in-range', binCenter >= minVal && binCenter <= maxVal);
      });
    }

    map.setFilter(LAYER_ID, computeFilter(panel) as never);
  }

  minInput.addEventListener('input', () => refresh(minInput));
  maxInput.addEventListener('input', () => refresh(maxInput));
  refresh(minInput);
}

/**
 * Wires the 5 dual-range sliders in the Custom filter accordion, including
 * their per-field histograms (scripts/build_custom_overlay.py bins the split-
 * set data at build time into public/data/custom_overlay_histograms.json —
 * small enough to fetch once here rather than deriving it from the 11MB
 * tileset client-side). Every slider move updates the map live: map.setFilter
 * is cheap here since the heavy work, the feeder x FSA geometric overlay,
 * already happened at build time, so this is just a property comparison on
 * already-tiled polygons.
 */
export async function initCustomOverlayFilters(map: MapLibreMap, histogramsUrl: string): Promise<void> {
  const toggle = document.getElementById('custom-overlay-filter-toggle');
  const panel = document.getElementById('custom-overlay-filter-panel');
  if (!toggle || !panel) return;

  let histograms: Histograms = {};
  try {
    const response = await fetch(histogramsUrl);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    histograms = (await response.json()) as Histograms;
  } catch (err) {
    // Sliders still work without histograms — just no distribution bars.
    console.warn('Custom overlay histograms failed to load; sliders will render without bars.', err);
  }

  for (const field of SLIDER_FIELDS) {
    initSliderField(map, panel, field, histograms[field]);
  }

  // Same plain inline accordion as the EV Charger filter panel — no
  // outside-click-close, since expanding just pushes the sidebar down rather
  // than floating over anything.
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    panel.hidden = expanded;
  });
}
