-- Controle de Estoque — Laboratório Pasteur
-- Cole este script inteiro no SQL Editor do Supabase e clique em "Run".
-- Pode ser executado mais de uma vez sem problema (também serve para atualizar).

-- ---------- Tabelas do estoque ----------
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

-- ---------- Membros da equipe (quem pode acessar) ----------
-- Quem cria conta entra como "pendente" e só acessa depois que um administrador aprovar.
create table if not exists public.membros (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  email     text not null,
  nome      text not null default '',
  status    text not null default 'pendente' check (status in ('pendente', 'aprovado', 'bloqueado')),
  admin     boolean not null default false,
  criado_em timestamptz not null default now()
);

-- perfil: cargo e setor
alter table public.membros add column if not exists cargo text not null default '';
alter table public.membros add column if not exists setor text not null default '';

-- contas que já existiam antes desta versão continuam com acesso
insert into public.membros (user_id, email, nome, status, admin, criado_em)
select u.id, u.email, coalesce(u.raw_user_meta_data ->> 'nome', ''), 'aprovado', false, u.created_at
from auth.users u
on conflict (user_id) do nothing;

-- se ainda não há administrador, a conta mais antiga vira administradora
update public.membros set admin = true, status = 'aprovado'
where user_id = (select user_id from public.membros order by criado_em limit 1)
  and not exists (select 1 from public.membros where admin);

-- toda conta nova vira um membro pendente (a primeira de todas já entra como administradora)
create or replace function public.novo_membro() returns trigger
language plpgsql security definer set search_path = public as $$
declare primeiro boolean := not exists (select 1 from public.membros where admin);
begin
  insert into public.membros (user_id, email, nome, cargo, setor, status, admin)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'nome', ''),
          coalesce(new.raw_user_meta_data ->> 'cargo', ''), coalesce(new.raw_user_meta_data ->> 'setor', ''),
          case when primeiro then 'aprovado' else 'pendente' end, primeiro)
  on conflict (user_id) do nothing;
  return new;
end $$;
drop trigger if exists novo_membro on auth.users;
create trigger novo_membro after insert on auth.users
  for each row execute function public.novo_membro();

create or replace function public.eh_membro() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.membros where user_id = auth.uid() and status = 'aprovado');
$$;
create or replace function public.eh_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.membros where user_id = auth.uid() and status = 'aprovado' and admin);
$$;

-- ---------- Segurança: só membros aprovados mexem no estoque ----------
alter table public.insumos enable row level security;
alter table public.locais  enable row level security;
alter table public.estoque enable row level security;
alter table public.movs    enable row level security;
alter table public.membros enable row level security;

revoke all on public.insumos, public.locais, public.estoque, public.movs, public.membros from anon;
grant select, insert, update, delete on public.insumos, public.locais, public.estoque, public.movs to authenticated;
grant select, update on public.membros to authenticated;

do $$
declare t text;
begin
  foreach t in array array['insumos', 'locais', 'estoque', 'movs'] loop
    execute format('drop policy if exists "equipe pode ler" on public.%I', t);
    execute format('drop policy if exists "equipe pode criar" on public.%I', t);
    execute format('drop policy if exists "equipe pode editar" on public.%I', t);
    execute format('drop policy if exists "equipe pode excluir" on public.%I', t);
    execute format('create policy "equipe pode ler" on public.%I for select to authenticated using (public.eh_membro())', t);
    execute format('create policy "equipe pode criar" on public.%I for insert to authenticated with check (public.eh_membro())', t);
    execute format('create policy "equipe pode editar" on public.%I for update to authenticated using (public.eh_membro()) with check (public.eh_membro())', t);
    execute format('create policy "equipe pode excluir" on public.%I for delete to authenticated using (public.eh_membro())', t);
  end loop;
end $$;

drop policy if exists "ver a si mesmo ou admin ve todos" on public.membros;
drop policy if exists "admin gerencia membros" on public.membros;
create policy "ver a si mesmo ou admin ve todos" on public.membros for select to authenticated
  using (user_id = auth.uid() or public.eh_admin());
create policy "admin gerencia membros" on public.membros for update to authenticated
  using (public.eh_admin()) with check (public.eh_admin());

-- e-mail e data de cadastro de um membro não podem ser alterados
create or replace function public.membros_protege() returns trigger
language plpgsql as $$
begin
  new.user_id := old.user_id; new.email := old.email; new.criado_em := old.criado_em;
  return new;
end $$;
drop trigger if exists membros_protege on public.membros;
create trigger membros_protege before update on public.membros
  for each row execute function public.membros_protege();

-- cada pessoa edita o próprio perfil (nome, cargo, setor), sem poder mudar status ou função
create or replace function public.atualizar_perfil(p_nome text, p_cargo text, p_setor text) returns void
language sql security definer set search_path = public as $$
  update public.membros
     set nome  = left(trim(coalesce(p_nome, '')), 60),
         cargo = left(trim(coalesce(p_cargo, '')), 60),
         setor = left(trim(coalesce(p_setor, '')), 60)
   where user_id = auth.uid();
$$;
revoke all on function public.atualizar_perfil(text, text, text) from public, anon;
grant execute on function public.atualizar_perfil(text, text, text) to authenticated;

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
  foreach t in array array['insumos', 'locais', 'estoque', 'movs', 'membros'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
