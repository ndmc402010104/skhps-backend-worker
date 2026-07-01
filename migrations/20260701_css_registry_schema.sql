/*
 * 檔案位置：skhps-backend-worker/migrations/20260701_css_registry_schema.sql
 * 時間戳：2026-07-01 23:40 UTC+8
 * 用途：建立 Supabase CSS Registry，作為 CSS總表 Sheet 的替代來源。
 *
 * 水庫邊界：
 * - 本 migration 只建立共用 CSS registry 資料結構。
 * - 不放 QR / Dressing / HIS 等業務邏輯。
 * - runtime 仍由 skhpsv2 共用 CSS runtime 讀取、組 CSS、cache、回報 loading gate。
 */

create extension if not exists pgcrypto;

create table if not exists public."CssRegistryImportBatch" (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'css-sheet-export',
  source_file text not null default '',
  env text not null default 'global',
  row_count integer not null default 0,
  note text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public."CssRegistryRule" (
  id uuid primary key default gen_random_uuid(),
  env text not null default 'global',
  sheet_key text not null default 'cssMain',
  component text not null,
  selector text not null,
  property text not null,
  value text not null,
  description text not null default '',
  source_updated_at text not null default '',
  layer text not null default 'override',
  enabled boolean not null default true,
  sort_order integer not null default 0,
  source text not null default 'css-sheet-import',
  import_batch_id uuid references public."CssRegistryImportBatch"(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint "CssRegistryRule_env_check" check (env in ('global', 'local-dev', 'dev', 'prod')),
  constraint "CssRegistryRule_layer_check" check (layer in ('default', 'override')),
  constraint "CssRegistryRule_component_not_blank" check (btrim(component) <> ''),
  constraint "CssRegistryRule_selector_not_blank" check (btrim(selector) <> ''),
  constraint "CssRegistryRule_property_not_blank" check (btrim(property) <> '')
);

create unique index if not exists "CssRegistryRule_upsert_key"
  on public."CssRegistryRule" (env, layer, component, selector, property);

create index if not exists "CssRegistryRule_runtime_lookup"
  on public."CssRegistryRule" (env, enabled, component, sort_order);

create index if not exists "CssRegistryRule_selector_lookup"
  on public."CssRegistryRule" (selector, property);

create or replace function public."touch_CssRegistryRule_updated_at"()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists "trg_CssRegistryRule_touch_updated_at" on public."CssRegistryRule";

create trigger "trg_CssRegistryRule_touch_updated_at"
before update on public."CssRegistryRule"
for each row
execute function public."touch_CssRegistryRule_updated_at"();

/*
 * Runtime effective rows:
 * - 同一 env + component + selector + property 只取一筆。
 * - override 優先於 default。
 * - 同 layer 重複時，後匯入/較大的 sort_order 優先。
 * - 同時提供 snake_case 欄位給 PostgREST filter/order，以及舊 JS 相容 alias。
 */
create or replace view public."CssRegistryRuntimeRow" as
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
  from public."CssRegistryRule" r
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

grant usage on schema public to service_role;
grant select, insert, update, delete on table public."CssRegistryImportBatch" to service_role;
grant select, insert, update, delete on table public."CssRegistryRule" to service_role;
grant select on table public."CssRegistryRuntimeRow" to service_role;

notify pgrst, 'reload schema';
