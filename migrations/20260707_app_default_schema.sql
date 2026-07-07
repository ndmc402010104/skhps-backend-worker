/*
 * 檔案位置：skhps-backend-worker/migrations/20260707_app_default_schema.sql
 * 時間戳：2026-07-07 12:18 UTC+8
 * 用途：建立共用「預設值」key-value 表，給各外部 App 存放「按一下就帶入」
 * 的常用預設值（例如 QR 簽到後台的科別／地點／會議性質），不綁死單一畫面。
 *
 * 水庫邊界：
 * - 本表是通用 key-value 儲存，用 scope 區分不同畫面/App，避免 key 互相打架。
 * - 只是「目前值」，改掉就覆蓋，不做歷史版本、不做審核紀錄。
 */

create extension if not exists pgcrypto;

create table if not exists public."Default" (
  id uuid primary key default gen_random_uuid(),
  scope text not null default '',
  key text not null,
  value text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists "Default_scope_key"
  on public."Default" (scope, key);

create or replace function public."touch_Default_updated_at"()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists "trg_Default_touch_updated_at" on public."Default";

create trigger "trg_Default_touch_updated_at"
before update on public."Default"
for each row
execute function public."touch_Default_updated_at"();

-- 種子資料：QR 簽到後台「輸入預設值」目前用的三個值，搬進表裡，行為不變。
insert into public."Default" (scope, key, value)
values
  ('qrSignin', 'departmentName', '整形外'),
  ('qrSignin', 'location', '友誼大樓8樓'),
  ('qrSignin', 'meetingType', '晨報會')
on conflict (scope, key) do nothing;

grant usage on schema public to service_role;
grant select, insert, update, delete on table public."Default" to service_role;

notify pgrst, 'reload schema';
