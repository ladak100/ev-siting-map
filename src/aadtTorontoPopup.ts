import type { MapGeoJSONFeature } from 'maplibre-gl';

export function renderAadtTorontoPopup(feature: MapGeoJSONFeature): string {
  const p = feature.properties ?? {};
  const locationName = p.location_name ?? 'Toronto street segment';
  const roadClass = p.road_class;
  const aadtEstimate = p.aadt_estimate;
  const isMeasured = p.is_measured === true;

  return `
    <div class="ev-popup">
      <h3>${locationName}</h3>
      <table>
        <tr><td>Estimated AADT</td><td><strong>${aadtEstimate != null ? Number(aadtEstimate).toLocaleString() : 'n/a'}</strong></td></tr>
        <tr><td>Data type</td><td><strong>${isMeasured ? 'Measured' : 'Interpolated'}</strong></td></tr>
        <tr><td>Road class</td><td><strong>${roadClass ?? 'n/a'}</strong></td></tr>
      </table>
    </div>
  `;
}
