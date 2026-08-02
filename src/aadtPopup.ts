import type { MapGeoJSONFeature } from 'maplibre-gl';

// Purely numeric (with an optional trailing letter suffix, e.g. "17B") gets
// a "Highway " prefix ("Highway 401"); an already-named route like "QEW"
// reads better left as-is ("QEW", not "Highway QEW").
const NUMBERED_HIGHWAY_RE = /^\d+[A-Za-z]?$/;

function formatHighwayTitle(highway: unknown): string {
  if (typeof highway !== 'string' || !highway) return 'Provincial highway segment';
  return NUMBERED_HIGHWAY_RE.test(highway) ? `Highway ${highway}` : highway;
}

// Same table shape as aadtTorontoPopup.ts (title, AADT, Road Type) for a
// consistent look across both AADT datasets — "AADT" not "Estimated AADT"
// here, since this is MTO's own official measurement, not a derived
// estimate. Road Type is a static "Provincial Highway" label rather than a
// real classification field: MTO's own data (scripts/fetch_aadt.py) has no
// per-segment functional-class field the way Toronto's TCL road_class does,
// and this dataset is provincial highways only, so the label is accurate
// even though it doesn't vary per feature.
export function renderAadtPopup(feature: MapGeoJSONFeature): string {
  const p = feature.properties ?? {};
  const title = formatHighwayTitle(p.highway);
  const aadt = p.aadt;

  return `
    <div class="ev-popup">
      <h3>${title}</h3>
      <table>
        <tr><td>AADT</td><td><strong>${aadt != null ? Number(aadt).toLocaleString() : 'n/a'}</strong></td></tr>
        <tr><td>Road Type</td><td><strong>Provincial Highway</strong></td></tr>
      </table>
    </div>
  `;
}
