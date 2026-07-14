// Leaflet + OpenStreetMap provider implementing the MapView contract.
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { isDark, markerHTML } from '../map.js';

const LIGHT = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const DARK = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const ATTR = '&copy; OpenStreetMap contributors';
const TOPO = 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png';
const SAT = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

function tileFor(type) {
  if (type === 'terrain') return { url: TOPO, opts: { attribution: '&copy; OpenTopoMap (CC-BY-SA)', maxZoom: 17, subdomains: 'abc' } };
  if (type === 'satellite') return { url: SAT, opts: { attribution: 'Tiles &copy; Esri', maxZoom: 19 } };
  return { url: isDark() ? DARK : LIGHT, opts: { attribution: ATTR, maxZoom: 19 } };
}

export function createLeafletView(node, { center = [36.5, 127.9], zoom = 7 } = {}) {
  const map = L.map(node, { zoomControl: true, scrollWheelZoom: true }).setView(center, zoom);
  map.zoomControl.setPosition('bottomright');
  let baseType = 'default';
  let tile;
  function applyBase(type) {
    baseType = type;
    if (tile) map.removeLayer(tile);
    const { url, opts } = tileFor(type);
    tile = L.tileLayer(url, opts).addTo(map);
    tile.setZIndex(0);
  }
  applyBase('default');
  const markerGroup = L.layerGroup().addTo(map);

  const pinIcon = (color, star) => L.divIcon({
    className: 'kr-pin', html: markerHTML(color, star),
    iconSize: star ? [22, 22] : [14, 14], iconAnchor: star ? [11, 11] : [7, 7],
  });

  return {
    setView([lat, lng], z) { map.setView([lat, lng], z ?? map.getZoom()); },
    panTo([lat, lng]) { map.panTo([lat, lng]); },
    flyTo([lat, lng], z) { map.flyTo([lat, lng], z ?? map.getZoom(), { duration: 0.6 }); },

    clearMarkers() { markerGroup.clearLayers(); },
    addMarker({ lat, lng, color, star = false, popupHTML, onClick, title }) {
      const mk = L.marker([lat, lng], { icon: pinIcon(color, star) }).addTo(markerGroup);
      if (popupHTML) mk.bindPopup(popupHTML);
      if (title) mk.bindTooltip(title);
      if (onClick) mk.on('click', onClick);
      return { openPopup() { mk.openPopup?.(); }, remove() { markerGroup.removeLayer(mk); } };
    },
    addDot({ lat, lng, color, title }) {
      const mk = L.circleMarker([lat, lng], { radius: 8, color: '#fff', weight: 2.5, fillColor: color, fillOpacity: 1 }).addTo(map);
      if (title) mk.bindTooltip(title);
      return { remove() { map.removeLayer(mk); } };
    },
    addPolyline(latlngs, { color = '#d1495b', weight = 4, opacity = 0.95, outline = false } = {}) {
      const g = L.layerGroup().addTo(map);
      if (outline) L.polyline(latlngs, { color: '#fff', weight: weight + 3, opacity: 0.85, lineCap: 'round' }).addTo(g);
      L.polyline(latlngs, { color, weight, opacity, lineCap: 'round' }).addTo(g);
      return { remove() { map.removeLayer(g); } };
    },
    addPolylines(lines, { color = '#e2872a', weight = 2.2, opacity = 0.8 } = {}) {
      const g = L.layerGroup().addTo(map);
      for (const line of lines) L.polyline(line, { color, weight, opacity }).addTo(g);
      return { remove() { map.removeLayer(g); } };
    },
    removeLayer(token) { (Array.isArray(token) ? token : [token]).forEach((t) => t?.remove?.()); },
    fitBounds(latlngs, pad = 0.15) { map.fitBounds(L.latLngBounds(latlngs).pad(pad)); },
    setBaseType(type) { if (type !== baseType) applyBase(type); },
    relayout() { map.invalidateSize(); },
    refreshTheme() { if (baseType === 'default') tile.setUrl(isDark() ? DARK : LIGHT); },
    destroy() { map.remove(); },
  };
}
