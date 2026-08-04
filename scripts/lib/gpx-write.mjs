// GPX 1.1 직렬화. 출처·라이선스·생성방식을 파일 자체에 남겨,
// 파일만 떼어놔도 "이게 무엇인지"를 알 수 있게 한다.
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const NS = 'https://github.com/jay-jang/kr-100-mountains/ns/1';

/**
 * @param {object} o
 * @param {string} o.name        트랙 이름
 * @param {string} o.desc        설명(성격을 반드시 밝힌다)
 * @param {[number,number][]} o.latlngs
 * @param {(number|null)[]} [o.eles]
 * @param {object} o.meta        provenance 확장 필드 (평문 key/value)
 * @param {{href:string,text:string}[]} [o.links]
 * @param {string} o.time        ISO8601 생성 시각
 */
export function toGPX({ name, desc, latlngs, eles = [], meta = {}, links = [], time }) {
  const pts = latlngs.map(([la, lo], i) => {
    const e = eles[i];
    const ele = Number.isFinite(e) ? `<ele>${e.toFixed(1)}</ele>` : '';
    return `      <trkpt lat="${la.toFixed(6)}" lon="${lo.toFixed(6)}">${ele}</trkpt>`;
  }).join('\n');

  const ext = Object.entries(meta)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `      <k100:${k}>${esc(v)}</k100:${k}>`)
    .join('\n');

  const linkXml = links.map((l) => `    <link href="${esc(l.href)}"><text>${esc(l.text)}</text></link>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="kr-100-mountains route-harvester"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:k100="${NS}"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${esc(name)}</name>
    <desc>${esc(desc)}</desc>
    <time>${esc(time)}</time>
${linkXml}
    <extensions>
${ext}
    </extensions>
  </metadata>
  <trk>
    <name>${esc(name)}</name>
    <desc>${esc(desc)}</desc>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}
