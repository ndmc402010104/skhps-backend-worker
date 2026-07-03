/*
檔案位置：skhps-backend-worker/migrations/20260703_qr_signin_meeting_selection_columns.sql
時間戳：2026-07-03 18:24 UTC+8
用途：QR 簽到後台主持人 / 紀錄者正式欄位；避免把明確業務資料塞進 metadata。
*/

alter table public."QrSigninMeeting"
  add column if not exists host_record_id uuid references public."QrSigninRecord" (id) on delete set null,
  add column if not exists recorder_record_id uuid references public."QrSigninRecord" (id) on delete set null;

create index if not exists qrsignin_meeting_host_record_idx
  on public."QrSigninMeeting" (host_record_id);

create index if not exists qrsignin_meeting_recorder_record_idx
  on public."QrSigninMeeting" (recorder_record_id);

comment on column public."QrSigninMeeting".host_record_id is
  'QR 簽到後台主持人：指向本場次 QrSigninRecord.id。';

comment on column public."QrSigninMeeting".recorder_record_id is
  'QR 簽到後台紀錄者：指向本場次 QrSigninRecord.id。';
