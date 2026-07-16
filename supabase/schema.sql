-- 대한민국 100대 명산 — 클라우드 등정 기록 스키마 (선택 기능)
-- Supabase 프로젝트의 SQL Editor에서 실행하세요. 자세한 설정은 README의
-- "클라우드 로그인/기록 동기화 (선택)" 참고.

create table if not exists public.hiked (
  user_id     uuid  not null references auth.users(id) on delete cascade,
  mountain_id text  not null,
  hiked_on    date,
  primary key (user_id, mountain_id)
);

alter table public.hiked enable row level security;

-- 각 사용자는 본인 행만 읽고/쓸 수 있음
drop policy if exists "own rows" on public.hiked;
create policy "own rows" on public.hiked
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
