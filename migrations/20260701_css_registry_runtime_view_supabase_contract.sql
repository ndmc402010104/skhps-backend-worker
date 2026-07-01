/*
 * 檔案位置：skhps-backend-worker/migrations/20260701_css_registry_runtime_view_supabase_contract.sql
 * 時間戳：2026-07-01 23:59 UTC+8
 * 用途：更新 Supabase CSS Registry runtime view，提供 PostgREST 可 filter/order 的 snake_case 欄位，並保留既有 JS alias。
 */

begin;

/*
 * create or replace view 只能在尾端加欄位，不能改動既有欄位的名字/順序。
 * 這次要把 sheetKey 挪到後面、中間插入 sheet_key 等 snake_case 欄位，屬於結構性變更，
 * 所以改成 drop + create，而不是 create or replace（實測 2026-07-02：
 * create or replace 會噴 42P16 cannot change name of view column "sheetKey" to "sheet_key"）。
 */
drop view if exists public."CssRegistryRuntimeRow";

create view public."CssRegistryRuntimeRow" as
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
