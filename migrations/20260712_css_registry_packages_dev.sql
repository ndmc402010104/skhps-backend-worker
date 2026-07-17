/*
 * 檔案位置：skhps-backend-worker/migrations/20260712_css_registry_packages_dev.sql
 * 時間戳：2026-07-12 12:10 UTC+8
 * 用途：在既有 skhps-db 內複製 production CSS rows 到 dev 專用 table/view，並新增 dev-only CSS package current/revision 儲存層。
 *
 * 安全邊界：
 * - production runtime 繼續讀 CssRegistryRule / CssRegistryRuntimeRow，不改原 table/view。
 * - dev Worker 固定讀寫 CssRegistryRuleDev / CssRegistryRuntimeRowDev。
 * - Worker 的 saveCssRegistryPackage 同步拒絕 global/prod 寫入。
 * - 表啟用 RLS，不授權 anon/authenticated；只允許 Worker service_role。
 */

create extension if not exists pgcrypto;

create table if not exists public."CssRegistryRuleDev"
  (like public."CssRegistryRule" including all);

alter table public."CssRegistryRuleDev" enable row level security;

insert into public."CssRegistryRuleDev"
select *
from public."CssRegistryRule"
on conflict do nothing;

create or replace view public."CssRegistryRuntimeRowDev"
with (security_invoker = true) as
with ranked as (
  select
    r.*,
    row_number() over (
      partition by r.env, r.component, r.selector, r.property
      order by
        case r.layer when 'override' then 2 else 1 end desc,
        r.sort_order desc,
        r.updated_at desc,
        r.id desc
    ) as rn
  from public."CssRegistryRuleDev" r
  where r.enabled = true
)
select
  env,
  sheet_key,
  sheet_key as "sheetKey",
  component,
  selector,
  selector as "className",
  property,
  value,
  description,
  source_updated_at,
  source_updated_at as "updatedAt",
  sort_order,
  sort_order as "__order",
  layer,
  source,
  updated_at
from ranked
where rn = 1;

create table if not exists public."CssRegistryPackage" (
  id uuid primary key default gen_random_uuid(),
  env text not null,
  package_key text not null,
  display_name text not null default '',
  version text not null default '0.1.0-dev',
  manifest jsonb not null default '{}'::jsonb,
  css_text text not null,
  enabled boolean not null default true,
  sort_order integer not null default 0,
  source text not null default 'css-setting-package-studio',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint "CssRegistryPackage_env_check" check (env in ('local-dev', 'dev')),
  constraint "CssRegistryPackage_key_not_blank" check (btrim(package_key) <> ''),
  constraint "CssRegistryPackage_css_not_blank" check (btrim(css_text) <> ''),
  constraint "CssRegistryPackage_manifest_object" check (jsonb_typeof(manifest) = 'object'),
  constraint "CssRegistryPackage_env_key_unique" unique (env, package_key)
);

create table if not exists public."CssRegistryPackageRevision" (
  id uuid primary key default gen_random_uuid(),
  env text not null,
  package_key text not null,
  display_name text not null default '',
  version text not null default '0.1.0-dev',
  manifest jsonb not null default '{}'::jsonb,
  css_text text not null,
  enabled boolean not null default true,
  sort_order integer not null default 0,
  source text not null default 'css-setting-package-studio',
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint "CssRegistryPackageRevision_env_check" check (env in ('local-dev', 'dev')),
  constraint "CssRegistryPackageRevision_key_not_blank" check (btrim(package_key) <> ''),
  constraint "CssRegistryPackageRevision_css_not_blank" check (btrim(css_text) <> ''),
  constraint "CssRegistryPackageRevision_manifest_object" check (jsonb_typeof(manifest) = 'object')
);

create index if not exists "CssRegistryPackage_runtime_lookup"
  on public."CssRegistryPackage" (env, enabled, sort_order, package_key);

create index if not exists "CssRegistryPackageRevision_history_lookup"
  on public."CssRegistryPackageRevision" (env, package_key, created_at desc);

alter table public."CssRegistryPackage" enable row level security;
alter table public."CssRegistryPackageRevision" enable row level security;

revoke all on table public."CssRegistryPackage" from anon, authenticated;
revoke all on table public."CssRegistryPackageRevision" from anon, authenticated;
revoke all on table public."CssRegistryRuleDev" from anon, authenticated;
revoke all on table public."CssRegistryRuntimeRowDev" from anon, authenticated;

grant usage on schema public to service_role;
grant select, insert, update, delete on table public."CssRegistryRuleDev" to service_role;
grant select on table public."CssRegistryRuntimeRowDev" to service_role;
grant select, insert, update, delete on table public."CssRegistryPackage" to service_role;
grant select, insert on table public."CssRegistryPackageRevision" to service_role;

notify pgrst, 'reload schema';
