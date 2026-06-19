-- 檔案：20260619_qr_signin_no_token_schema.sql
-- 用途：QR signin Cloudflare / Supabase 新版 schema
-- 原則：不再使用驗證碼欄位；QR URL 只帶 meetingId，驗證交給 Cloudflare + Supabase。
-- 注意：舊 Google Form / Sheet 的「驗證碼」欄位只作歷史來源，不匯入正式欄位。

create extension if not exists pgcrypto;

-- 共用 updated_at trigger
create or replace function skhps_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- 1) QR 簽到場次 / 會議主檔
-- 來源可來自 Google Calendar、手動建立、CSV 匯入。QR URL 應帶 id，不帶驗證碼。
create table if not exists "QrSigninMeeting" (
  id uuid primary key default gen_random_uuid(),

  app_id text not null default 'qr-signin',
  env text not null default 'prod',

  source text not null default 'manual',
  source_id text,
  calendar_id text,

  title text not null,
  meeting_date date,
  time_label text,
  starts_at timestamptz,
  ends_at timestamptz,
  timezone text not null default 'Asia/Taipei',

  open_before_minutes integer not null default 30,
  close_after_minutes integer not null default 10,

  enabled boolean not null default true,
  status text not null default 'active',

  created_by text,
  updated_by text,
  notes text,
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint qrsignin_meeting_env_check
    check (env in ('local-dev', 'dev', 'prod')),
  constraint qrsignin_meeting_status_check
    check (status in ('active', 'archived', 'cancelled')),
  constraint qrsignin_meeting_window_check
    check (open_before_minutes >= 0 and close_after_minutes >= 0)
);

create unique index if not exists qrsignin_meeting_unique_source
  on "QrSigninMeeting" (env, source, source_id)
  where source_id is not null and btrim(source_id) <> '';

create index if not exists qrsignin_meeting_env_status_idx
  on "QrSigninMeeting" (env, status, enabled);

create index if not exists qrsignin_meeting_starts_at_idx
  on "QrSigninMeeting" (starts_at);

create index if not exists qrsignin_meeting_title_idx
  on "QrSigninMeeting" (title);

drop trigger if exists qrsignin_meeting_touch_updated_at on "QrSigninMeeting";
create trigger qrsignin_meeting_touch_updated_at
before update on "QrSigninMeeting"
for each row execute function skhps_touch_updated_at();

-- 2) QR 簽到紀錄
-- 這張取代舊「表單回覆」與「後台人員狀態設定」的主要紀錄表。
-- 不存 token / 驗證碼。重複簽到由 meeting_id + employee_id 或 meeting_id + name 防重。
create table if not exists "QrSigninRecord" (
  id uuid primary key default gen_random_uuid(),

  meeting_id uuid not null references "QrSigninMeeting" (id) on delete cascade,
  app_id text not null default 'qr-signin',
  env text not null default 'prod',

  name text not null,
  employee_id text,
  role text,
  staff_source text not null default 'StaffMaster',

  signed_at timestamptz,
  submitted_at timestamptz not null default now(),

  status text not null default 'signed',
  reason text,
  source text not null default 'qr',

  duplicate_of uuid references "QrSigninRecord" (id),
  client_request_id text,

  created_by text,
  updated_by text,
  note text,
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint qrsignin_record_env_check
    check (env in ('local-dev', 'dev', 'prod')),
  constraint qrsignin_record_status_check
    check (status in (
      'signed',
      'duplicate',
      'late',
      'outside_window',
      'leave',
      'absent',
      'excused',
      'manual',
      'void',
      'error'
    )),
  constraint qrsignin_record_name_not_blank
    check (btrim(name) <> '')
);

create index if not exists qrsignin_record_meeting_idx
  on "QrSigninRecord" (meeting_id, submitted_at desc);

create index if not exists qrsignin_record_employee_idx
  on "QrSigninRecord" (employee_id);

create index if not exists qrsignin_record_status_idx
  on "QrSigninRecord" (status);

create index if not exists qrsignin_record_source_idx
  on "QrSigninRecord" (source);

-- 員編存在時：同一場次同一員編只保留一筆有效紀錄。
create unique index if not exists qrsignin_record_unique_active_employee
  on "QrSigninRecord" (meeting_id, employee_id)
  where employee_id is not null
    and btrim(employee_id) <> ''
    and status not in ('duplicate', 'void', 'error');

-- 沒有員編時：用姓名做弱防重，避免 Google Form 舊資料或手動輸入重複暴增。
create unique index if not exists qrsignin_record_unique_active_name_without_employee
  on "QrSigninRecord" (meeting_id, lower(name))
  where (employee_id is null or btrim(employee_id) = '')
    and status not in ('duplicate', 'void', 'error');

drop trigger if exists qrsignin_record_touch_updated_at on "QrSigninRecord";
create trigger qrsignin_record_touch_updated_at
before update on "QrSigninRecord"
for each row execute function skhps_touch_updated_at();

-- 3) 簽到紀錄修改歷史
-- 後台補登、請假、標記刪除、狀態修正都寫這張，避免覆蓋後查不回來。
create table if not exists "QrSigninRecordAudit" (
  id uuid primary key default gen_random_uuid(),

  record_id uuid references "QrSigninRecord" (id) on delete set null,
  meeting_id uuid references "QrSigninMeeting" (id) on delete set null,

  action text not null,
  actor_name text,
  actor_employee_id text,
  note text,

  before_data jsonb not null default '{}'::jsonb,
  after_data jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),

  constraint qrsignin_record_audit_action_not_blank
    check (btrim(action) <> '')
);

create index if not exists qrsignin_record_audit_record_idx
  on "QrSigninRecordAudit" (record_id, created_at desc);

create index if not exists qrsignin_record_audit_meeting_idx
  on "QrSigninRecordAudit" (meeting_id, created_at desc);

-- 4) 後台 Dashboard 用 summary view
create or replace view "QrSigninMeetingSummary" as
select
  m.id,
  m.app_id,
  m.env,
  m.title,
  m.meeting_date,
  m.time_label,
  m.starts_at,
  m.ends_at,
  m.timezone,
  m.enabled,
  m.status,
  m.source,
  m.source_id,
  m.created_at,
  m.updated_at,
  count(r.id)::integer as total_records,
  count(r.id) filter (where r.status in ('signed', 'manual'))::integer as signed_count,
  count(r.id) filter (where r.status = 'late')::integer as late_count,
  count(r.id) filter (where r.status = 'outside_window')::integer as outside_window_count,
  count(r.id) filter (where r.status = 'leave')::integer as leave_count,
  count(r.id) filter (where r.status = 'absent')::integer as absent_count,
  count(r.id) filter (where r.status = 'void')::integer as void_count
from "QrSigninMeeting" m
left join "QrSigninRecord" r
  on r.meeting_id = m.id
  and r.status <> 'void'
group by m.id;

-- 5) 給 Supabase REST / Worker 讀取的建議註解
comment on table "QrSigninMeeting" is 'QR 簽到場次主檔；QR URL 使用 meeting id，不使用驗證碼。';
comment on table "QrSigninRecord" is 'QR 簽到紀錄；取代 Google Form 回覆與後台狀態 Sheet，不存驗證碼。';
comment on table "QrSigninRecordAudit" is 'QR 簽到紀錄後台修改歷史。';
comment on view "QrSigninMeetingSummary" is 'QR 簽到後台 Dashboard 場次統計。';
