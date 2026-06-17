/*
 * 檔案位置：skhps-backend-worker/migrations/002_quick_login.sql
 * 時間戳記：2026-06-17
 * 用途：SKHPS quick-login 第一階段 staff / systems / entries schema。
 */

create extension if not exists "pgcrypto";

create table if not exists quick_login_staff (
  id uuid primary key default gen_random_uuid(),
  staff_code text not null unique,
  display_name text not null,
  department text,
  role_title text,
  active boolean not null default true,
  sort_order integer not null default 999,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists quick_login_systems (
  id uuid primary key default gen_random_uuid(),
  system_key text not null unique,
  title text not null,
  url text not null,
  description text,
  active boolean not null default true,
  sort_order integer not null default 999,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists quick_login_entries (
  id uuid primary key default gen_random_uuid(),
  staff_code text not null references quick_login_staff(staff_code) on delete cascade,
  system_key text not null references quick_login_systems(system_key) on delete cascade,
  login_account text,
  login_hint text,
  active boolean not null default true,
  sort_order integer not null default 999,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (staff_code, system_key)
);

create index if not exists idx_quick_login_staff_active_sort
  on quick_login_staff(active, sort_order);

create index if not exists idx_quick_login_systems_active_sort
  on quick_login_systems(active, sort_order);

create index if not exists idx_quick_login_entries_staff_code
  on quick_login_entries(staff_code);

create index if not exists idx_quick_login_entries_system_key
  on quick_login_entries(system_key);

create index if not exists idx_quick_login_entries_active_sort
  on quick_login_entries(active, sort_order);
