import type { MapGeoJSONFeature } from 'maplibre-gl';

// Matches the layer's own sequential green fill (see layers.ts) so the popup
// chart reads as "the same metric, zoomed in" rather than a new color story.
const LINE_COLOR = '#327a45';
const FILL_COLOR = 'rgba(50, 122, 69, 0.15)';
const CHART_WIDTH = 220;
const CHART_HEIGHT = 48;
const Y_AXIS_MARGIN = 28; // reserves space on the left for tick labels
const PLOT_WIDTH = CHART_WIDTH - Y_AXIS_MARGIN;

function parseSeries(raw: unknown): [string, number][] {
  const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj as Record<string, number>);
}

// Keeps axis labels short (e.g. "3.4k" instead of "3382") — there's only
// ~24px of width for them next to the chart.
function formatCompact(value: number): string {
  if (Math.abs(value) >= 1000) {
    const thousands = value / 1000;
    return (Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)) + 'k';
  }
  return String(Math.round(value));
}

// True significant figures, not a fixed decimal count: 87.9 -> "88",
// 6.02 -> "6.0", 0.74 -> "0.74". toPrecision falls back to scientific
// notation when the integer part has more digits than the requested
// precision (e.g. 100 at 2 sig figs -> "1.0e+2") — guarded against here
// since a houses_pct of 100.0 is a real possibility (an all-house rural FSA).
function formatSigFigs(value: number, sigFigs: number): string {
  const precise = value.toPrecision(sigFigs);
  if (precise.includes('e') || precise.includes('E')) {
    return String(Math.round(value));
  }
  return precise;
}

// A single-series sparkline needs no legend (the heading names it) and no
// hover layer — this is a small popup chart, not a full interactive chart.
// It does get a y-axis per user request, so the actual value changes (not
// just the shape) are visible at a glance.
function buildSparkline(entries: [string, number][]): string {
  if (entries.length < 2) return '';

  const values = entries.map(([, v]) => v);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;

  const points = values.map((v, i) => {
    const x = Y_AXIS_MARGIN + (i / (values.length - 1)) * PLOT_WIDTH;
    const y = CHART_HEIGHT - ((v - min) / range) * (CHART_HEIGHT - 4) - 2;
    return [x, y] as const;
  });

  const linePoints = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaPoints = `${Y_AXIS_MARGIN},${CHART_HEIGHT} ${linePoints} ${CHART_WIDTH},${CHART_HEIGHT}`;

  return `
    <svg width="${CHART_WIDTH}" height="${CHART_HEIGHT}" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" class="ev-sparkline">
      <line x1="${Y_AXIS_MARGIN}" y1="0" x2="${Y_AXIS_MARGIN}" y2="${CHART_HEIGHT}" stroke="#e1e0d9" stroke-width="1" />
      <text x="${Y_AXIS_MARGIN - 4}" y="7" text-anchor="end" font-size="9" fill="#898781">${formatCompact(max)}</text>
      <text x="${Y_AXIS_MARGIN - 4}" y="${CHART_HEIGHT - 2}" text-anchor="end" font-size="9" fill="#898781">${formatCompact(min)}</text>
      <polygon points="${areaPoints}" fill="${FILL_COLOR}" stroke="none" />
      <polyline points="${linePoints}" fill="none" stroke="${LINE_COLOR}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
    </svg>
  `;
}

export function renderEvAdoptionPopup(feature: MapGeoJSONFeature): string {
  const p = feature.properties ?? {};
  const fsa = p.CFSAUID ?? '';
  const totalEv = p.total_ev;
  const adoptionPct = p.ev_adoption_pct;
  const housesPct = p.houses_pct;
  const medianIncome = p.median_income;

  const series = parseSeries(p.ev_by_quarter);
  const sparkline = buildSparkline(series);
  const firstLabel = series[0]?.[0] ?? '';
  const lastLabel = series[series.length - 1]?.[0] ?? '';

  return `
    <div class="ev-popup">
      <h3>${fsa}</h3>
      <table>
        <tr><td>Total EVs</td><td><strong>${totalEv ?? '—'}</strong></td></tr>
        <tr><td>EV Adoption</td><td><strong>${adoptionPct != null ? formatSigFigs(adoptionPct, 2) + '%' : 'n/a'}</strong></td></tr>
        <tr><td>Houses &amp; Townhomes</td><td><strong>${housesPct != null ? formatSigFigs(housesPct, 2) + '%' : 'n/a'}</strong></td></tr>
        <tr><td>Median Household Income</td><td><strong>${medianIncome != null ? '$' + medianIncome.toLocaleString('en-CA') : 'n/a'}</strong></td></tr>
      </table>
      ${sparkline}
      ${sparkline ? `<div class="ev-sparkline-axis"><span>${firstLabel}</span><span>${lastLabel}</span></div>` : ''}
    </div>
  `;
}
