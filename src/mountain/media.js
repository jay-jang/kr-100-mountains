import { el } from '../dom.js';
import { fmtElev } from './format.js';
import { openModal } from '../modal.js';

// 정상석 모양은 위치 안내용 도식이다. 실제 정상석 사진·설치 여부로 표현하지 않는다.
const STONE = '<svg width="38" height="44" viewBox="0 0 38 44" fill="none" aria-hidden="true"><path d="M9 38 11 8 18 3 27 8 29 38Z" fill="var(--surface-2)" stroke="currentColor" stroke-width="1.5"/><path d="M5 39h28M16 15h8M16 20h8M16 25h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

export function mountainMedia(m, { showSummit }) {
  const photo = m.image;
  const figure = el('figure', { class: 'mt-photo', hidden: !photo });
  const fallback = el('p', { class: 'mt-photo-missing', hidden: !!photo }, '대표 사진 준비 중 · 정상석 실물 정보 미확인');
  if (photo) {
    const credit = () => el('figcaption', { class: 'mt-photo-credit' },
      el('span', {}, photo.author), ' · ',
      el('a', { href: photo.source, target: '_blank', rel: 'noopener', 'aria-label': `${m.name_full} 사진 원본과 출처` }, 'Wikimedia Commons'), ' · ',
      el('a', { href: photo.license_url, target: '_blank', rel: 'noopener' }, photo.license));
    const image = el('img', { src: `${import.meta.env.BASE_URL}${photo.file}`, alt: photo.alt,
      width: photo.width, height: photo.height, decoding: 'async' });
    image.addEventListener('error', () => { figure.hidden = true; fallback.hidden = false; }, { once: true });
    const open = el('button', { type: 'button', class: 'mt-photo-open', 'aria-label': `${m.name_full} 대표 사진 크게 보기`,
      onClick: () => openModal({ title: `${m.name_full} 대표 사진`, className: 'mt-photo-modal', content:
        el('figure', {}, el('img', { src: image.src, alt: photo.alt }), credit()) }) }, image);
    figure.append(open, credit());
  }
  const precise = m.coord_confidence === 'high';
  const summit = el('button', { type: 'button', class: 'mt-summit-place', onClick: showSummit,
    'aria-label': `${m.name_full} 정상 위치 지도에서 보기` },
    el('span', { class: 'mt-summit-stone', html: STONE }),
    el('span', { class: 'mt-summit-text' },
      el('strong', {}, m.summit_name || m.name, el('span', {}, ` 정상 · ${fmtElev(m.elevation_m)}`)),
      el('span', { class: 'mt-summit-coord tabular' }, Number.isFinite(m.lat) && Number.isFinite(m.lon)
        ? `${m.lat.toFixed(5)}, ${m.lon.toFixed(5)}${precise ? '' : ' · 추정 위치'}` : '좌표 확인 중')),
    el('span', { class: 'mt-summit-go', 'aria-hidden': 'true' }, '지도 보기'));
  return el('section', { class: 'mt-media', 'aria-label': `${m.name_full} 사진과 정상 안내` }, figure, summit, fallback);
}
