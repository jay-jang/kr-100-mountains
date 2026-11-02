// Wikidata P18 / 같은 항목의 위키백과 대표 사진 → Commons 라이선스 확인 → 로컬 축소본과 출처 저장.
// 생성 이미지·정상석 추정 사진은 사용하지 않는다. 실패한 산은 화면에서 정상 위치 안내를 쓴다.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { haversine } from './lib/geo.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public/media/mountains');
const catalog = join(ROOT, 'data/mountain-media.json');
const sources = JSON.parse(readFileSync(join(ROOT, 'data/mountain-media-sources.json'))).mountains;
const mountains = new Map(JSON.parse(readFileSync(join(ROOT, 'public/data/mountains.json'))).mountains.map(m => [m.id, m]));
const media = existsSync(catalog) ? JSON.parse(readFileSync(catalog)).mountains : {};
const force = process.argv.includes('--force');
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',');
const headers = { 'User-Agent': 'Kr100MountainGuide/1.0 (https://github.com/jay-jang/kr-100-mountains)' };
const plain = s => String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
async function json(url) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
function save() {
  writeFileSync(catalog, JSON.stringify({ source: 'Wikidata P18 / linked Wikipedia page image / Wikimedia Commons', collected_at: new Date().toISOString().slice(0, 10), mountains: media }, null, 2) + '\n');
}
mkdirSync(OUT, { recursive: true });
const todo = sources.filter(s => (!only || only.includes(s.id)) && (force || !media[s.id] || !existsSync(join(ROOT, 'public', media[s.id].file))));
for (let i = 0; i < todo.length; i += 40) {
  const batch = todo.slice(i, i + 40);
  const data = await json('https://www.wikidata.org/w/api.php?' + new URLSearchParams({ action: 'wbgetentities', ids: batch.map(s => s.qid).join('|'), props: 'claims|sitelinks', format: 'json' }));
  const pageImages = new Map();
  for (const lang of ['en', 'ko']) {
    const titles = batch.map(s => data.entities[s.qid]?.sitelinks?.[`${lang}wiki`]?.title).filter(Boolean);
    if (!titles.length) continue;
    const result = await json(`https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({ action: 'query', titles: titles.join('|'), prop: 'pageimages|pageprops', piprop: 'name', pilicense: 'free', redirects: '1', format: 'json' }));
    for (const p of Object.values(result.query?.pages || {})) {
      const qid = p.pageprops?.wikibase_item;
      if (qid && p.pageimage && !pageImages.has(qid)) pageImages.set(qid, p.pageimage);
    }
  }
  for (const s of batch) {
    try {
      const claims = data.entities[s.qid]?.claims;
      const coord = claims?.P625?.find(c => c.rank !== 'deprecated')?.mainsnak?.datavalue?.value;
      const m = mountains.get(s.id);
      if (!m || !coord || haversine(m.lat, m.lon, coord.latitude, coord.longitude) > 4000) throw new Error('산 위치 불일치');
      const image = claims.P18?.find(c => c.rank === 'preferred') || claims.P18?.find(c => c.rank !== 'deprecated');
      const title = image?.mainsnak?.datavalue?.value || pageImages.get(s.qid);
      if (!title) { console.log(`${s.id}: 대표 사진 없음`); continue; }
      const result = await json('https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({ action: 'query', titles: 'File:' + title, prop: 'imageinfo', iiprop: 'url|extmetadata|size|mime', iiurlwidth: '640', format: 'json' }));
      const info = Object.values(result.query.pages)[0]?.imageinfo?.[0];
      const ext = info?.extmetadata;
      const license = plain(ext?.LicenseShortName?.value);
      const licenseUrl = ext?.LicenseUrl?.value?.replace(/^http:/, 'https:');
      if (!info || !/^(CC BY(?:-SA)? [234]\.[05]|CC0|Public domain)$/.test(license) || ext?.Restrictions?.value) throw new Error(`미지원 라이선스 ${license}`);
      if (!/^image\/(jpeg|png|webp)$/.test(info.mime)) throw new Error('사진 형식 아님');
      const res = await fetch(info.thumburl || info.url, { headers, signal: AbortSignal.timeout(30000) });
      if (!res.ok || !res.headers.get('content-type')?.startsWith('image/')) throw new Error(`사진 HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > 2_000_000) throw new Error('파일 크기 제한');
      const suffix = info.mime === 'image/png' ? 'png' : info.mime === 'image/webp' ? 'webp' : 'jpg';
      const file = `media/mountains/${s.id}.${suffix}`;
      writeFileSync(join(ROOT, 'public', file), bytes);
      media[s.id] = { file, alt: `${m.name_full} 대표 풍경`, author: plain(ext.Artist?.value) || 'Wikimedia Commons contributors', license, license_url: licenseUrl || 'https://creativecommons.org/publicdomain/mark/1.0/', source: info.descriptionurl, wikidata: `https://www.wikidata.org/wiki/${s.qid}`, original: info.url.split('?')[0], width: info.thumbwidth || info.width, height: info.thumbheight || info.height };
      save();
      console.log(`${s.id}: ${license} · ${bytes.length} bytes`);
    } catch (e) { console.error(`${s.id}: ${e.message}`); }
  }
}
save();
console.log(`사진 ${Object.keys(media).length}개`);
