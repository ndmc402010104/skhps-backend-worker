/*
 * 檔案位置：skhps-backend-worker/migrations/003_grants.sql
 * 時間戳記：2026-06-17
 * 用途：授權 SKHPS Cloudflare Worker 透過 Supabase API 讀取第一階段資料表。
 */

grant usage on schema public to service_role;

grant select on table public.apps to service_role;
grant select on table public.app_environments to service_role;
grant select on table public.app_cards to service_role;

grant select on table public.quick_login_staff to service_role;
grant select on table public.quick_login_systems to service_role;
grant select on table public.quick_login_entries to service_role;

notify pgrst, 'reload schema';
