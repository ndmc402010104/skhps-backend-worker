-- 檔案位置：skhps-backend-worker/migrations/20260629_quick_login_newstaff_composite_unique.sql
-- 時間戳：2026-06-29 22:54 UTC+8
-- 用途：讓 quick-login NewStaff 可記錄同員工編號的不同密碼；以新增時間 YYYYMMDDHHmmss 作為主鍵，只在「員工編號 + 密碼」完全相同時視為重複。

alter table public."NewStaff"
  drop constraint if exists "NewStaff_pkey";

alter table public."NewStaff"
  add column if not exists "新增時間" text;

with numbered as (
  select
    ctid,
    to_char(
      (now() at time zone 'Asia/Taipei') + (row_number() over (order by ctid) || ' seconds')::interval,
      'YYYYMMDDHH24MISS'
    ) as new_key
  from public."NewStaff"
  where "新增時間" is null or "新增時間" = ''
)
update public."NewStaff" target
set "新增時間" = numbered.new_key
from numbered
where target.ctid = numbered.ctid;

alter table public."NewStaff"
  alter column "新增時間" set not null;

alter table public."NewStaff"
  add constraint "NewStaff_pkey" primary key ("新增時間");

create unique index if not exists "NewStaff_emp_password_key"
  on public."NewStaff" ("員工編號", "密碼");

grant usage on schema public to service_role;
grant select, insert on table public."NewStaff" to service_role;
