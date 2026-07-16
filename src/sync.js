// 로그인 상태에서 등정 기록을 Supabase와 동기화한다(오프라인 우선: 로컬이 항상 UI 소스).
import { hikedMap, replaceHiked, setHikedSyncHook } from './store.js';
import {
  CLOUD_ENABLED, initAuth, onAuthChange, currentUser,
  pullHiked, pushHiked, removeHiked, pushAll,
} from './auth.js';

const minDate = (a, b) => (!a ? b : !b ? a : a < b ? a : b);

export async function initSync() {
  if (!CLOUD_ENABLED) return;
  try { await initAuth(); } catch (e) { console.warn('auth init failed', e); return; }
  if (currentUser()) await activate();
  onAuthChange(async (user) => { if (user) await activate(); else deactivate(); });
}

async function activate() {
  try {
    const cloud = await pullHiked();
    const local = hikedMap();
    const merged = { ...cloud };
    for (const [id, d] of Object.entries(local)) merged[id] = id in merged ? minDate(merged[id], d) : d;
    replaceHiked(merged);        // 로컬 + UI 갱신 (동기화 훅은 호출 안 함)
    await pushAll(merged);       // 클라우드에 로컬-only 항목 반영
    setHikedSyncHook(async (action, id, date) => {
      try {
        if (action === 'set') await pushHiked(id, date);
        else if (action === 'del') await removeHiked(id);
        else if (action === 'bulk' || action === 'clear') await reconcile();
      } catch (e) { console.warn('sync write failed', e); }
    });
  } catch (e) { console.warn('cloud sync failed — 로컬만 사용', e); }
}

function deactivate() { setHikedSyncHook(null); }

// import/clear 후: 클라우드를 로컬과 완전 일치시킨다(추가 upsert + 삭제).
async function reconcile() {
  const local = hikedMap();
  const cloud = await pullHiked();
  await pushAll(local);
  const toDelete = Object.keys(cloud).filter((id) => !(id in local));
  for (const id of toDelete) await removeHiked(id);
}
