-- 檔案位置：skhps-backend-worker/migrations/20260629_quick_login_newstaff_grants.sql
-- 時間戳：2026-06-29 22:43 UTC+8
-- 用途：補上 quick-login NewStaff 測試帳號記錄所需的 Supabase 權限。

grant usage on schema public to service_role;
grant select, insert on table public."NewStaff" to service_role;
