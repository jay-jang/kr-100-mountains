#!/usr/bin/env python3
"""Geofabrik PBF의 도보 관계를 로컬 수집기/전국 걷기길의 동일한 입력으로 변환.
stdlib + osmium-tool만 사용. 공개 좌표의 출처는 OpenStreetMap, ODbL.
사용: python3 scripts/extract-osm-trekking.py .cache/osm/south-korea-YYMMDD.osm.pbf
"""
import json
import pathlib
import subprocess
import sys
import xml.etree.ElementTree as ET

root = pathlib.Path(__file__).resolve().parent.parent
pbf = pathlib.Path(sys.argv[1]).resolve()
meta = json.loads((root / '.cache/osm/tiles/meta.json').read_text())
if meta['pbf'] != pbf.name:
    raise ValueError('길 타일과 관계의 PBF가 다릅니다. npm run osm:local 먼저 실행하세요.')
cache = root / '.cache/trekking'
(cache / 'rel').mkdir(parents=True, exist_ok=True)
xml = root / '.cache/osm/trekking.osm'
subprocess.run(['osmium', 'tags-filter', str(pbf), 'r/route=hiking,foot,walking', '-o', str(xml), '--overwrite'], check=True)
nodes, ways, relations = {}, {}, []
for _, obj in ET.iterparse(xml, events=('end',)):
    if obj.tag == 'node':
        nodes[int(obj.attrib['id'])] = [float(obj.attrib['lat']), float(obj.attrib['lon'])]
    elif obj.tag == 'way':
        pts = [nodes[int(n.attrib['ref'])] for n in obj.findall('nd') if int(n.attrib['ref']) in nodes]
        if len(pts) >= 2:
            ways[int(obj.attrib['id'])] = {'type': 'way', 'id': int(obj.attrib['id']),
                'tags': {t.attrib['k']: t.attrib['v'] for t in obj.findall('tag')},
                'geometry': [{'lat': p[0], 'lon': p[1]} for p in pts]}
    elif obj.tag == 'relation':
        tags = {t.attrib['k']: t.attrib['v'] for t in obj.findall('tag')}
        if tags.get('route') in ('hiking', 'foot', 'walking'):
            members = [dict(m.attrib, ref=int(m.attrib['ref'])) for m in obj.findall('member')]
            pts = [p for m in members if m['type'] == 'way' for p in ways.get(m['ref'], {}).get('geometry', [])]
            if pts:
                relations.append({'type': 'relation', 'id': int(obj.attrib['id']), 'tags': tags, 'members': members,
                    'bounds': {'minlat': min(p['lat'] for p in pts), 'maxlat': max(p['lat'] for p in pts),
                               'minlon': min(p['lon'] for p in pts), 'maxlon': max(p['lon'] for p in pts)}})
    else:
        continue
    obj.clear()

def write(path, value):
    tmp = pathlib.Path(str(path) + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')))
    tmp.replace(path)

write(root / '.cache/osm/trekking-relations.json', {'pbf': pbf.name, 'snapshot': meta['snapshot'], 'relations': relations, 'ways': list(ways.values())})
write(cache / 'probe-relations.json', {'elements': relations})
for r in relations:
    refs = [m['ref'] for m in r['members'] if m['type'] == 'way' and m['ref'] in ways]
    write(cache / 'rel' / f"{r['id']}.json", {'id': r['id'], 'fetched': meta['snapshot'], 'tags': r['tags'],
        'members': r['members'], 'ways': {str(i): [[p['lat'],p['lon']] for p in ways[i]['geometry']] for i in refs}})
xml.unlink()
print(f"도보 관계 {len(relations)}개 · 멤버 길 {len(ways)}개 · 스냅숏 {meta['snapshot']}")
