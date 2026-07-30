import type { MapGeoJSONFeature } from 'maplibre-gl';

export function renderLoadCapacityPopup(feature: MapGeoJSONFeature): string {
  const p = feature.properties ?? {};
  const feederId = p.idldc ?? 'Feeder';
  const capacity = p.capacity;
  const configuration = p.configuration;
  const voltageLL = p.feeder_ltl_voltage_3ph;

  return `
    <div class="ev-popup">
      <h3>${feederId}</h3>
      <table>
        <tr><td>Capacity (MVA)</td><td><strong>${capacity != null ? capacity : 'n/a'}</strong></td></tr>
        <tr><td>Configuration</td><td><strong>${configuration ?? 'n/a'}</strong></td></tr>
        <tr><td>Feeder L-L (kV)</td><td><strong>${voltageLL != null ? voltageLL : 'n/a'}</strong></td></tr>
      </table>
    </div>
  `;
}
