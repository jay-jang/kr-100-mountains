// 위치 추적 + 내비게이션 유틸.

// 지속적 위치 추적. onUpdate({lat,lng,accuracy,altitude,heading,speed}) 반복 호출.
// 반환값을 호출하면 추적 중지.
export function watchPosition(onUpdate, onError, opts = {}) {
  if (!navigator.geolocation) { onError?.({ code: 0, message: '위치 기능을 지원하지 않는 브라우저입니다.' }); return () => {}; }
  const id = navigator.geolocation.watchPosition(
    (p) => onUpdate({
      lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy,
      altitude: p.coords.altitude, heading: p.coords.heading, speed: p.coords.speed,
    }),
    (e) => onError?.(e),
    { enableHighAccuracy: true, maximumAge: 1500, timeout: 15000, ...opts },
  );
  return () => navigator.geolocation.clearWatch(id);
}

export function fmtDist(m) {
  if (m == null) return '—';
  return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + 'km' : Math.round(m) + 'm';
}

// 외부 지도 앱 길찾기 링크(목적지=정상). 카카오·구글은 웹/앱 모두 안정적.
export function directionsLinks(name, lat, lng) {
  const n = encodeURIComponent(name || '목적지');
  return {
    kakao: `https://map.kakao.com/link/to/${n},${lat},${lng}`,
    google: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`,
  };
}
