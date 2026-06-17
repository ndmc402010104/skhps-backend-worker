/*
 * 檔案位置：skhps-backend-worker/migrations/001_apps.sql
 * 時間戳記：2026-06-17
 * 用途：SKHPS 新後端第一階段 apps / external app registry schema。
 */

create extension if not exists "pgcrypto";

create table if not exists apps (
  id uuid primary key default gen_random_uuid(),
  app_id text not null unique,
  title text not null,
  description text,
  group_key text,
  default_href text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app_environments (
  id uuid primary key default gen_random_uuid(),
  app_id text not null references apps(app_id) on delete cascade,
  env text not null check (env in ('local', 'dev', 'prod')),
  href text,
  enabled boolean not null default false,
  placement text not null default 'hidden' check (placement in ('frontend', 'backend', 'hidden')),
  sort_order integer not null default 999,
  maintenance boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (app_id, env)
);

create table if not exists app_cards (
  id uuid primary key default gen_random_uuid(),
  app_id text not null references apps(app_id) on delete cascade,
  title text,
  subtitle text,
  description text,
  icon text,
  badge text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (app_id)
);

create index if not exists idx_apps_active
  on apps(active);

create index if not exists idx_app_environments_env_enabled
  on app_environments(env, enabled);

create index if not exists idx_app_environments_placement_sort
  on app_environments(env, placement, sort_order);

create index if not exists idx_app_cards_app_id
  on app_cards(app_id);
