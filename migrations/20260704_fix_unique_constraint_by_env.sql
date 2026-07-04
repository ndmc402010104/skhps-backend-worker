/*
 * 檔案位置：skhps-backend-worker/migrations/20260704_fix_unique_constraint_by_env.sql
 * 時間戳記：2026-07-04
 * 用途：修復 QrSigninRecord 的 UNIQUE 約束，加入 env 條件
 * 背景：同一個人應該可以在不同環境有多條成功簽到記錄
 *       舊約束沒有考慮 env，導致 prod 和 local-dev 的記錄互相衝突
 */

-- 删除舊的約束（沒有 env 的）
drop index if exists public.qrsignin_record_unique_success_employee;
drop index if exists public.qrsignin_record_unique_success_name_without_employee;
drop index if exists public.qrsignin_record_unique_current_employee;
drop index if exists public.qrsignin_record_unique_current_name_without_employee;

-- 建立新的約束（加入 env 條件）
create unique index if not exists qrsignin_record_unique_success_employee
  on public."QrSigninRecord" (env, meeting_id, employee_id)
  where (
    employee_id is not null
    and btrim(employee_id) <> ''
    and status in ('signed', 'manual')
  );

create unique index if not exists qrsignin_record_unique_success_name_without_employee
  on public."QrSigninRecord" (env, meeting_id, lower(name))
  where (
    (employee_id is null or btrim(employee_id) = '')
    and status in ('signed', 'manual')
  );

create unique index if not exists qrsignin_record_unique_current_employee
  on public."QrSigninRecord" (env, meeting_id, employee_id)
  where (
    employee_id is not null
    and btrim(employee_id) <> ''
    and status not in ('duplicate', 'void', 'error')
  );

create unique index if not exists qrsignin_record_unique_current_name_without_employee
  on public."QrSigninRecord" (env, meeting_id, lower(name))
  where (
    (employee_id is null or btrim(employee_id) = '')
    and status not in ('duplicate', 'void', 'error')
  );
