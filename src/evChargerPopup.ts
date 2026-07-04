import type { MapGeoJSONFeature } from 'maplibre-gl';
import { NETWORK_DISPLAY_NAMES } from './evChargerFilters';

export function renderEvChargerPopup(feature: MapGeoJSONFeature): string {
  const p = feature.properties ?? {};
  const name = p.name || 'EV Charging Station';
  const rawNetwork = p.network || 'Non-Networked';
  const network = NETWORK_DISPLAY_NAMES[rawNetwork] ?? rawNetwork;
  const address = [p.address, p.city].filter(Boolean).join(', ');
  const l2 = p.l2_ports ?? 0;
  const dcfc = p.dcfc_ports ?? 0;

  return `
    <div class="ev-popup">
      <h3>${name}</h3>
      <table>
        <tr><td>Network</td><td><strong>${network}</strong></td></tr>
        ${address ? `<tr><td>Address</td><td>${address}</td></tr>` : ''}
        <tr><td>L2 Ports</td><td><strong>${l2}</strong></td></tr>
        <tr><td>DCFC Ports</td><td><strong>${dcfc}</strong></td></tr>
        ${p.connector_types ? `<tr><td>Connectors</td><td>${p.connector_types}</td></tr>` : ''}
      </table>
    </div>
  `;
}
