/*
 * 檔案位置：skhps-backend-worker/migrations/20260701_css_registry_runtime_view_supabase_contract.sql
 * 時間戳：2026-07-01 23:59 UTC+8
 * 用途：更新 Supabase CSS Registry runtime view，提供 PostgREST 可 filter/order 的 snake_case 欄位，並保留既有 JS alias。
 */

begin;

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

grant select on table public."CssRegistryRuntimeRow" to service_role;

notify pgrst, 'reload schema';

commit;
