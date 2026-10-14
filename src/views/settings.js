// 설정 #/settings — 바꾸면 바로 적용·저장된다(저장 버튼 없음).
// 화면 · 지도 · 목록 · 경로 도구 · 정보. 기능 스위치는 입구만 숨기고 저장된 기록은 건드리지 않는다.
import '../css/pages.css';
import { el } from '../dom.js';
import { icon } from '../icons.js';
import {
  PREF_GROUPS, pref, setPref, onPrefs, resetPrefs, isPrefChanged,
  getTheme, setTheme, MAP_TYPES, getMapType, setMapType, defaultMapType,
} from '../prefs.js';
import { cachedPosition, clearPosition, onPositionChange, positionAgeText } from '../position.js';
import { pageBar, confirmAction, extLink } from './pagekit.js';

const THEMES = [['system', '시스템'], ['light', '밝게'], ['dark', '어둡게']];
const SOURCE_URL = 'https://ko.wikipedia.org/wiki/대한민국_100대_명산_목록';
const OSM_COPYRIGHT = 'https://www.openstreetmap.org/copyright';

export async function renderSettings(root) {
  const live = el('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const say = (text) => { live.textContent = ''; requestAnimationFrame(() => { live.textContent = text; }); };
  const main = el('div', { class: 'pg-main pg-narrow' });

  // 바꾼 직후 눈에 보이는 짧은 알림 + [되돌리기](약 4초). 저장 버튼이 없는 화면이라 잘못 누른 것을 바로 무를 수 있어야 한다.
  // 화면 낭독기에는 위 live 영역이 이미 알리므로 알림판 자체는 라이브 영역으로 두지 않는다(두 번 읽히지 않게).
  const toastText = el('span', { class: 'set-toast-text' });
  const undoBtn = el('button', { type: 'button', class: 'btn' }, '되돌리기');
  const toast = el('div', { class: 'set-toast', hidden: true }, toastText, undoBtn);
  let toastTimer = 0, undoFn = null;
  function hideToast() { clearTimeout(toastTimer); toast.hidden = true; undoFn = null; }
  /** text를 알리고 알림판을 띄운다. undo가 있으면 [되돌리기]가 그것을 실행한다. */
  function notify(text, undo) {
    say(text);
    toastText.textContent = text;
    undoFn = undo || null;
    undoBtn.hidden = !undo;
    toast.hidden = false;
    clearTimeout(toastTimer);
    // 포인터가 올라가 있거나 키보드 포커스가 알림 안에 있으면 닫지 않고 기다린다.
    const later = () => { if (toast.matches(':hover, :focus-within')) toastTimer = setTimeout(later, 1500); else hideToast(); };
    toastTimer = setTimeout(later, 4000);
  }
  undoBtn.addEventListener('click', () => { const f = undoFn; hideToast(); f?.(); });

  const page = el('div', { class: 'pg pg-settings' }, pageBar({ title: '설정' }), main, live, toast);
  root.append(page);

  const refreshers = [];   // 설정이 바뀌면(다른 탭 포함) 화면 상태를 다시 맞춘다

  // ---------- 화면 ----------
  main.append(section('화면',
    segRow({
      id: 'set-theme', label: '테마', note: '시스템은 기기의 밝게·어둡게 설정을 따릅니다.',
      options: THEMES, get: getTheme, def: 'system', set: setTheme,
    })));

  // ---------- 지도 ----------
  const defType = defaultMapType();
  const defTypeLabel = MAP_TYPES.find(([k]) => k === defType)?.[1] || '일반';
  const mapGroup = PREF_GROUPS.find((g) => g.title === '지도');
  main.append(section('지도',
    segRow({
      id: 'set-maptype', label: '기본 지도 종류', note: `처음 지도를 열 때 쓰는 바탕입니다. 기본값은 ${defTypeLabel}입니다.`,
      options: MAP_TYPES, get: getMapType, def: defType, set: setMapType,
    }),
    ...(mapGroup?.items || []).map(switchRow)));

  // ---------- 목록 · 경로 도구 (그 밖의 PREF_GROUPS도 순서대로) ----------
  for (const g of PREF_GROUPS) {
    if (g === mapGroup) continue;
    const lead = g.title === '경로 도구' ? '끄면 입구만 숨깁니다. 저장된 기록과 링크로 연 경로는 그대로 열립니다.' : null;
    main.append(section(g.title, lead ? el('p', { class: 'set-lead' }, lead) : null, ...g.items.map(switchRow)));
  }

  // ---------- 정보 ----------
  const posNote = el('span', { class: 'set-note', id: 'set-pos-note' });
  const posBtn = el('button', { type: 'button', class: 'btn set-act', 'aria-labelledby': 'set-pos-label', 'aria-describedby': 'set-pos-note' }, '지우기');
  let posCleared = false;
  function paintPos() {
    const p = cachedPosition();
    if (p) {
      posCleared = false;
      posNote.textContent = `가까운 순 정렬에 쓰는 마지막 위치(${positionAgeText(p.ts)} 측정)를 이 기기에서 지웁니다. 위치 권한은 브라우저 사이트 설정에서 바꿉니다.`;
      posBtn.disabled = false; posBtn.textContent = '지우기';
    } else {
      posNote.textContent = posCleared
        ? '지웠습니다. 위치 권한은 브라우저 사이트 설정에서 바꿉니다.'
        : '저장된 위치가 없습니다. 위치 권한은 브라우저 사이트 설정에서 바꿉니다.';
      posBtn.disabled = true; posBtn.textContent = posCleared ? '지움' : '지우기';
    }
  }
  posBtn.addEventListener('click', () => {
    posCleared = true;
    clearPosition();
    paintPos();
    say('저장된 위치를 지웠습니다.');
  });
  paintPos();
  const offPos = onPositionChange(paintPos);

  const resetNote = el('span', { class: 'set-note', id: 'set-reset-note' });
  const resetBtn = el('button', { type: 'button', class: 'btn set-act', 'aria-label': '기본값으로 되돌리기', 'aria-describedby': 'set-reset-note' }, '되돌리기');
  function changedCount() {
    let n = PREF_GROUPS.flatMap((g) => g.items).filter((i) => isPrefChanged(i.key)).length;
    if (getTheme() !== 'system') n++;
    if (getMapType() !== defType) n++;
    return n;
  }
  function paintReset() {
    const n = changedCount();
    resetBtn.disabled = !n;
    resetNote.textContent = n
      ? `바꾼 항목 ${n}개를 처음 상태로 돌립니다. 등정 기록은 지우지 않습니다.`
      : '모든 항목이 기본값입니다.';
  }
  resetBtn.addEventListener('click', async () => {
    const ok = await confirmAction({
      title: '기본값으로 되돌리기',
      message: `테마·지도·기능 설정 ${changedCount()}개를 처음 상태로 돌립니다. 등정 기록과 저장한 경로는 그대로 둡니다.`,
      confirm: '되돌리기',
    });
    if (!ok || !root.isConnected) return;
    hideToast();   // 남아 있는 [되돌리기]가 초기화 이전 값으로 되돌리지 않게
    resetPrefs();
    if (getTheme() !== 'system') setTheme('system');
    if (getMapType() !== defType) setMapType(defType);
    syncAll();
    say('설정을 기본값으로 되돌렸습니다.');
  });
  refreshers.push(paintReset);

  const meta = el('dl', { class: 'set-sources' },
    el('dt', {}, '명산 목록'),
    el('dd', {}, '산림청 100대 명산 · 블랙야크 명산100 · 한국의산하 인기명산 100 · 월간산 100대 명산. 네 목록을 합쳐 149곳입니다.'),
    el('dt', {}, '지도·등산로·걷기길 선'),
    el('dd', {}, '© OpenStreetMap 기여자, ODbL 라이선스. ', extLink(OSM_COPYRIGHT, '저작권 안내'),
      el('br'), '지도 바탕 그림의 출처는 지도 모서리에 표시합니다.'),
    el('dt', {}, '고도'),
    el('dd', {}, '계산 경로의 고도는 SRTM 1초 지형 자료(NASA·USGS), 실시간 고도 조회는 Open-Meteo를 씁니다. 실측 고도가 아닙니다.'),
    el('dt', {}, '대표 코스·현장 정보'),
    el('dd', {}, '국립공원공단·지자체의 탐방 안내와 공개 자료를 교차검증해 정리했습니다. 항목마다 확인일과 출처를 함께 적습니다.'));

  main.append(section('정보',
    infoRow('자료 출처', meta),
    sourceRow(),
    infoRow('면책',
      el('p', { class: 'set-para' },
        '코스·거리·시간·난이도·경로 선은 공개 자료를 모아 정리한 참고 정보입니다. 계산 경로는 실측 기록이 아니고, 탐방로 통제·예약·날씨는 바뀔 수 있습니다. 산행 전에 국립공원공단·지자체의 공식 안내를 확인하고, 안전은 스스로 판단하세요. 이 정보를 이용해 생긴 결과에 대해 책임지지 않습니다.')),
    el('div', { class: 'set-row' },
      el('span', { class: 'set-text' }, el('span', { class: 'set-label', id: 'set-pos-label' }, '저장된 위치 지우기'), posNote),
      posBtn),
    el('div', { class: 'set-row' },
      el('span', { class: 'set-text' }, el('span', { class: 'set-label' }, '기본값으로 되돌리기'), resetNote),
      resetBtn)));
  paintReset();

  // ---------- 부품 ----------
  function section(title, ...rows) {
    const id = `set-h-${title.replace(/\s+/g, '')}`;
    return el('section', { class: 'set-sec', 'aria-labelledby': id },
      el('h2', { class: 'pg-h2', id }, title), el('div', { class: 'set-rows' }, ...rows));
  }

  function changedTag(id) {
    return el('span', { class: 'set-changed', id, hidden: true }, '변경됨');
  }

  function switchRow(item) {
    const base = `set-${item.key}`;
    const input = el('input', {
      type: 'checkbox', role: 'switch', id: base,
      'aria-labelledby': `${base}-label`, 'aria-describedby': `${base}-note ${base}-chg`,
    });
    const tag = changedTag(`${base}-chg`);
    const row = el('label', { class: 'switch-row set-row', for: base },
      el('span', { class: 'set-text' },
        el('span', { class: 'set-label-line' }, el('span', { class: 'set-label', id: `${base}-label` }, item.label), tag),
        el('span', { class: 'set-note', id: `${base}-note` }, item.note)),
      input);
    const sync = () => {
      input.checked = !!pref(item.key);
      tag.hidden = !isPrefChanged(item.key);
    };
    input.addEventListener('change', () => {
      const on = input.checked;
      const saved = setPref(item.key, on);
      sync(); paintReset();
      notify(`${item.label} ${on ? '켬' : '끔'}${saved ? '' : '. 이 브라우저에는 저장하지 못해 이번에만 적용합니다'}`, () => {
        setPref(item.key, !on);
        sync(); paintReset();
        say(`되돌렸습니다: ${item.label} ${on ? '끔' : '켬'}`);
        input.focus({ preventScroll: true });   // 알림이 사라져도 포커스가 바뀐 항목에 남게
      });
    });
    sync();
    refreshers.push(sync);
    return row;
  }

  function segRow({ id, label, note, options, get, set, def }) {
    const tag = changedTag(`${id}-chg`);
    const group = el('div', { class: 'seg wide set-seg', role: 'group', 'aria-labelledby': `${id}-label`, 'aria-describedby': `${id}-note ${id}-chg` });
    const nameOf = (v) => options.find(([k]) => k === v)?.[1] || v;
    const buttons = options.map(([value, text]) => {
      const b = el('button', { type: 'button', class: 'seg-btn', 'aria-pressed': 'false', dataset: { value } }, text);
      b.addEventListener('click', () => {
        const prev = get();
        if (prev === value) return;
        set(value); sync(); paintReset();
        notify(`${label} ${text}`, () => {
          set(prev); sync(); paintReset();
          say(`되돌렸습니다: ${label} ${nameOf(prev)}`);
          buttons.find((x) => x.dataset.value === prev)?.focus({ preventScroll: true });
        });
      });
      group.append(b);
      return b;
    });
    const sync = () => {
      const cur = get();
      buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === cur)));
      tag.hidden = cur === def;
    };
    sync();
    refreshers.push(sync);
    return el('div', { class: 'set-row set-row-stack' },
      el('span', { class: 'set-text' },
        el('span', { class: 'set-label-line' }, el('span', { class: 'set-label', id: `${id}-label` }, label), tag),
        el('span', { class: 'set-note', id: `${id}-note` }, note)),
      group);
  }

  function sourceRow() {
    const a = el('a', { class: 'set-row set-row-link', href: SOURCE_URL, target: '_blank', rel: 'noopener noreferrer' },
      el('span', { class: 'set-text' },
        el('span', { class: 'set-label' }, '원자료'),
        el('span', { class: 'set-note' }, '위키백과 「대한민국 100대 명산 목록」', el('span', { class: 'sr-only' }, ' (새 창)'))));
    a.insertAdjacentHTML('beforeend', icon('external', { size: 18 }));
    return a;
  }

  function infoRow(label, body) {
    return el('div', { class: 'set-row set-row-stack set-info' },
      el('span', { class: 'set-label' }, label), body);
  }

  function syncAll() { refreshers.forEach((fn) => fn()); }
  const offPrefs = onPrefs(() => { if (root.isConnected) syncAll(); });
  const onTheme = () => syncAll();
  window.addEventListener('kr100:theme', onTheme);
  // 다른 탭에서 테마·지도 종류를 바꾼 경우(prefs 키가 아니라 storage 이벤트로만 알 수 있다)
  const onStorage = (e) => { if (e.key === 'kr100:theme' || e.key === 'kr100:maptype') syncAll(); };
  window.addEventListener('storage', onStorage);

  return () => {
    clearTimeout(toastTimer);
    offPrefs(); offPos();
    window.removeEventListener('kr100:theme', onTheme);
    window.removeEventListener('storage', onStorage);
  };
}
