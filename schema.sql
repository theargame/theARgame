-- The AR Game -- Supabase Schema
-- Run this in the SQL editor at:
-- https://supabase.com/dashboard/project/oksaekiomphiwdxoeojo

create extension if not exists "pgcrypto";

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  created_at timestamptz default now()
);

create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  player_red uuid references players(id),
  player_yellow uuid references players(id),
  board integer[] not null default array_fill(0, array[42]),
  current_turn integer not null default 1,
  status text not null default 'waiting',
  winner integer default null,
  location_name text,
  location_lat double precision,
  location_lng double precision,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists moves (
  id uuid primary key default gen_random_uuid(),
  game_id uuid references games(id) on delete cascade,
  player_id uuid references players(id),
  column_index integer not null check (column_index between 0 and 6),
  row_index integer not null check (row_index between 0 and 5),
  piece integer not null check (piece in (1, 2)),
  move_number integer not null,
  created_at timestamptz default now()
);

create index if not exists idx_games_status on games(status);
create index if not exists idx_moves_game_id on moves(game_id);

alter publication supabase_realtime add table games;
alter publication supabase_realtime add table moves;

create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger games_updated_at
  before update on games
  for each row execute function update_updated_at();

alter table players enable row level security;
alter table games enable row level security;
alter table moves enable row level security;

create policy "Allow all for demo" on players for all using (true) with check (true);
create policy "Allow all for demo" on games for all using (true) with check (true);
create policy "Allow all for demo" on moves for all using (true) with check (true);