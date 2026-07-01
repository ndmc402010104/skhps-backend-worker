/*
 * 檔案位置：skhps-backend-worker/migrations/20260701_css_registry_swipe_table_function_boundary.sql
 * 時間戳：2026-07-01 23:58 UTC+8
 * 用途：收斂 Supabase CSS Registry 內 swipe-table 舊匯入規則，避免 registry 外觀 rows 覆蓋 swipe-table.css 的互動位移與 action rail 狀態。
 *
 * 水庫邊界：
 * - 本檔只調整共用 CSS Registry 的 swipe-table 規則啟用狀態。
 * - 不加入 QR / Dressing / HIS 等業務邏輯。
 * - swipe-table.css 保留元件運作必要的 position / transform / transition / pointer-events。
 * - Supabase CSS Registry 保留顏色、背景、邊框、字級、間距等主要外觀來源。
 */

begin;

insert into public."CssRegistryImportBatch" (id, source, source_file, env, row_count, note)
values (
  'd3a38fb1-2d18-4d6f-9e5e-72a3a842f7b1'::uuid,
  'css-registry-adjustment',
  '20260701_css_registry_swipe_table_function_boundary.sql',
  'global',
  0,
  'Disable imported swipe-table function-control rows that conflict with component runtime behavior.'
)
on conflict (id) do update set
  note = excluded.note;

update public."CssRegistryRule"
set
  enabled = false,
  description = concat(
    description,
    case when description = '' then '' else ' / ' end,
    'disabled: function-control belongs to swipe-table component runtime, not Supabase visual registry'
  ),
  import_batch_id = 'd3a38fb1-2d18-4d6f-9e5e-72a3a842f7b1'::uuid
where component = 'swipe-table'
  and enabled = true
  and (
    property in ('transform', 'transition', 'opacity', 'pointer-events')
    or (
      selector like '%.is-action-open%'
      and property in ('padding-left', 'margin-left')
    )
  );

update public."CssRegistryImportBatch"
set row_count = (
  select count(*)
  from public."CssRegistryRule"
  where import_batch_id = 'd3a38fb1-2d18-4d6f-9e5e-72a3a842f7b1'::uuid
    and enabled = false
)
where id = 'd3a38fb1-2d18-4d6f-9e5e-72a3a842f7b1'::uuid;

notify pgrst, 'reload schema';

commit;
