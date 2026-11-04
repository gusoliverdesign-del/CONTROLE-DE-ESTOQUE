-- Controle de Estoque — Laboratório Pasteur
-- Cole este script inteiro no SQL Editor do Supabase e clique em "Run".
-- Pode ser executado mais de uma vez sem problema.

-- ---------- Tabelas ----------
create table if not exists public.insumos (
  id    text primary key,
  nome  text not null,
  un    text not null default ''
);

create table if not exists public.locais (
  nome  text primary key,
  tipo  text not null default 'Sala',
  ordem integer not null default 0
);

create table if not exists public.estoque (
  local     text not null,
  insumo_id text not null,
  inicial   numeric not null default 0,
  minimo    numeric,                       -- vazio = "SEM MÍNIMO"
  primary key (local, insumo_id)
);

create table if not exists public.movs (
  uid        text primary key,
  data       date not null,
  local      text not null,
  insumo_id  text not null,
  tipo       text not null check (tipo in ('ENTRADA', 'SAÍDA', 'TRANSFERÊNCIA')),
  qtd        numeric not null check (qtd > 0),
  resp       text not null default '',
  obs        text not null default '',
  destino    text not null default '',
  criado_por text default (auth.jwt() ->> 'email'),  -- preenchido automaticamente
  criado_em  timestamptz not null default now()
);

create index if not exists movs_data_idx on public.movs (data);

-- ---------- Segurança: só usuários logados (a equipe) ----------
alter table public.insumos enable row level security;
alter table public.locais  enable row level security;
alter table public.estoque enable row level security;
alter table public.movs    enable row level security;

revoke all on public.insumos, public.locais, public.estoque, public.movs from anon;
grant select, insert, update, delete on public.insumos, public.locais, public.estoque, public.movs to authenticated;

do $$
declare t text;
begin
  foreach t in array array['insumos', 'locais', 'estoque', 'movs'] loop
    execute format('drop policy if exists "equipe pode ler" on public.%I', t);
    execute format('drop policy if exists "equipe pode criar" on public.%I', t);
    execute format('drop policy if exists "equipe pode editar" on public.%I', t);
    execute format('drop policy if exists "equipe pode excluir" on public.%I', t);
    execute format('create policy "equipe pode ler" on public.%I for select to authenticated using (true)', t);
    execute format('create policy "equipe pode criar" on public.%I for insert to authenticated with check (true)', t);
    execute format('create policy "equipe pode editar" on public.%I for update to authenticated using (true) with check (true)', t);
    execute format('create policy "equipe pode excluir" on public.%I for delete to authenticated using (true)', t);
  end loop;
end $$;

-- quem registrou a movimentação não pode ser alterado depois
create or replace function public.movs_preserva_autor() returns trigger
language plpgsql as $$
begin
  new.criado_por := old.criado_por;
  new.criado_em  := old.criado_em;
  return new;
end $$;
drop trigger if exists movs_preserva_autor on public.movs;
create trigger movs_preserva_autor before update on public.movs
  for each row execute function public.movs_preserva_autor();

-- ---------- Tempo real ----------
do $$
declare t text;
begin
  foreach t in array array['insumos', 'locais', 'estoque', 'movs'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
