-- Семейный бюджет: одна таблица документов, доступ только у общего аккаунта семьи,
-- изменения приходят всем в реальном времени.
-- Supabase → SQL Editor → New query → вставьте весь файл → Run.

create table if not exists public.budget_docs (
  path text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.budget_docs enable row level security;

-- Доступ только у аккаунта, чей пароль — семейный PIN. Email совпадает с FAMILY_EMAIL в config.js.
drop policy if exists "family only" on public.budget_docs;
create policy "family only" on public.budget_docs
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'family@family-budget.app')
  with check ((auth.jwt() ->> 'email') = 'family@family-budget.app');

revoke all on public.budget_docs from anon;
grant select, insert, update, delete on public.budget_docs to authenticated;

-- Глубокое слияние JSON: вложенные объекты сливаются, остальное заменяется.
create or replace function public.jsonb_deep_merge(a jsonb, b jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  k text;
  result jsonb;
begin
  if a is null or jsonb_typeof(a) <> 'object' or jsonb_typeof(b) <> 'object' then
    return b;
  end if;
  result := a;
  for k in select jsonb_object_keys(b) loop
    result := jsonb_set(result, array[k], public.jsonb_deep_merge(result -> k, b -> k), true);
  end loop;
  return result;
end;
$$;

-- Дописать поля в документ (создаёт его, если нет). Выполняется с правами вызвавшего,
-- поэтому правило "family only" действует и здесь.
create or replace function public.merge_doc(p_path text, p_patch jsonb)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.budget_docs as d (path, data)
  values (p_path, p_patch)
  on conflict (path) do update
    set data = public.jsonb_deep_merge(d.data, excluded.data),
        updated_at = now();
$$;

revoke execute on function public.merge_doc(text, jsonb) from public, anon;
grant execute on function public.merge_doc(text, jsonb) to authenticated;

-- Обновления в реальном времени.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'budget_docs'
  ) then
    alter publication supabase_realtime add table public.budget_docs;
  end if;
end;
$$;
