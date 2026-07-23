// Overpass API 요청 — 여러 미러를 순서대로 시도(가용성 편차 대응).
// overpass-api.de 는 과부하 시 504를 자주 내므로(콘솔 오류) 다른 미러를 먼저 시도한다.
// 각 요청에 타임아웃을 두어 멈춘 미러에서 오래 대기하지 않는다.
const ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export async function overpassFetch(query, { timeoutMs = 28000 } = {}) {
  let lastErr;
  for (const url of ENDPOINTS) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), signal: ctrl.signal });
      clearTimeout(to);
      if (res.ok) return await res.json();
      lastErr = new Error('HTTP ' + res.status);
    } catch (e) { clearTimeout(to); lastErr = e; }
  }
  throw lastErr || new Error('Overpass 요청 실패');
}
