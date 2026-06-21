/*
 * 檔案位置：skhps-backend-worker/migrations/20260621_qr_signin_grants.sql
 * 時間戳記：2026-06-21 21:21 UTC+8
 * 用途：授權 Cloudflare Worker 使用 Supabase service_role 讀寫 QR 簽到資料表。
 */

grant usage on schema public to service_role;

grant select, insert, update, delete on table public."QrSigninMeeting" to service_role;
grant select, insert, update, delete on table public."QrSigninRecord" to service_role;
grant select, insert, update, delete on table public."QrSigninRecordAudit" to service_role;
grant select on table public."QrSigninMeetingSummary" to service_role;

notify pgrst, 'reload schema';
