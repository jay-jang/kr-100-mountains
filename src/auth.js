// 클라우드 인증(Supabase) — 빌드 시 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 가 있으면 활성화.
// 키가 없으면 CLOUD_ENABLED=false 로 두어 앱은 기존처럼 브라우저 저장(localStorage)만 사용한다.
// SDK 는 활성화된 경우에만 동적 import 되므로 미설정 배포에는 로드되지 않는다.
export const CLOUD_ENABLED = !!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);
const REDIRECT = window.location.origin + import.meta.env.BASE_URL;

let _client = null;
async function client() {
  if (!CLOUD_ENABLED) return null;
  if (_client) return _client;
  const { createClient } = await import('@supabase/supabase-js');
  _client = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return _client;
}

let _user = null;
export function currentUser() { return _user; }

const listeners = new Set();
export function onAuthChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { listeners.forEach((fn) => fn(_user)); }

export async function initAuth() {
  if (!CLOUD_ENABLED) return null;
  const c = await client();
  const { data } = await c.auth.getSession();
  _user = data.session?.user || null;
  c.auth.onAuthStateChange((_evt, session) => { _user = session?.user || null; emit(); });
  return _user;
}

// Supabase에서 활성화된 외부 로그인 제공자 목록(예: {email:true, google:true}).
// 활성화된 버튼만 UI에 노출하기 위함.
export async function authProviders() {
  if (!CLOUD_ENABLED) return {};
  try {
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/auth/v1/settings`,
      { headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY } });
    const d = await res.json();
    return d.external || {};
  } catch { return {}; }
}

export async function signInWithEmail(email) {
  const c = await client();
  return c.auth.signInWithOtp({ email, options: { emailRedirectTo: REDIRECT } });
}
export async function signInWithGoogle() {
  const c = await client();
  return c.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: REDIRECT } });
}
export async function signOut() {
  const c = await client();
  if (c) await c.auth.signOut();
  _user = null; emit();
}

/* ---- hiked 동기화 (테이블: public.hiked, RLS: 본인 행만) ---- */
export async function pullHiked() {
  const c = await client(); if (!c || !_user) return {};
  const { data, error } = await c.from('hiked').select('mountain_id, hiked_on').eq('user_id', _user.id);
  if (error) throw error;
  const map = {}; (data || []).forEach((r) => { map[r.mountain_id] = r.hiked_on || '1970-01-01'; });
  return map;
}
export async function pushHiked(id, date) {
  const c = await client(); if (!c || !_user) return;
  const { error } = await c.from('hiked').upsert(
    { user_id: _user.id, mountain_id: id, hiked_on: date || null }, { onConflict: 'user_id,mountain_id' });
  if (error) throw error;
}
export async function removeHiked(id) {
  const c = await client(); if (!c || !_user) return;
  const { error } = await c.from('hiked').delete().eq('user_id', _user.id).eq('mountain_id', id);
  if (error) throw error;
}
export async function pushAll(map) {
  const c = await client(); if (!c || !_user) return;
  const rows = Object.entries(map).map(([mountain_id, hiked_on]) => ({ user_id: _user.id, mountain_id, hiked_on: hiked_on || null }));
  if (rows.length) { const { error } = await c.from('hiked').upsert(rows, { onConflict: 'user_id,mountain_id' }); if (error) throw error; }
}
