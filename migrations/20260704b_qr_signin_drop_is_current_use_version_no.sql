/*
 * 檔案位置：skhps-backend-worker/migrations/20260704b_qr_signin_drop_is_current_use_version_no.sql
 * 時間戳記：2026-07-04
 * 用途：拿掉 is_current 這個「需要兩步驟(先UPDATE舊版false、再INSERT新版true)才能維護
 * 的可變旗標」，改成單純比寫入順序（version_no 全域遞增序號）。
 *
 * 背景：is_current 搭配「一人一場只能有一筆生效版本」的唯一索引，逼得每次版本化都要
 * 「先把舊版標 false、再 INSERT 新版 true」兩步——這兩步不是原子操作，同一個人被連續
 * 點兩次（雙擊、或水庫同一次操作連發多個事件）時，兩個請求前後腳讀到同一筆舊版本當
 * 基準，都想 INSERT 一筆新的 is_current=true，其中一個就會撞唯一索引丟 409，
 * 整個 request 變 500，前端樂觀更新的畫面被 rollback（使用者看到打勾又消失）。
 *
 * 新設計：每次編輯都是單純一筆 INSERT，不用先 UPDATE 任何東西，天生不會撞。
 * 「目前生效版本」變成查詢時的概念：同一個人同一場會議，version_no 最大的那筆。
 */

alter table public."QrSigninRecord"
  add column if not exists version_no bigint;

-- 回填：既有資料用 created_at 排序給一個遞增序號（避免 timestamp 精度不足時序不明確的情況也有穩定順序）。
with ordered as (
  select id, row_number() over (order by created_at asc, id asc) as rn
  from public."QrSigninRecord"
  where version_no is null
)
update public."QrSigninRecord" r
set version_no = ordered.rn
from ordered
where r.id = ordered.id;

-- 建立序號產生器，接續在既有回填值之後，並綁定成該欄位預設值。
create sequence if not exists qrsigninrecord_version_no_seq;
select setval('qrsigninrecord_version_no_seq', (select coalesce(max(version_no), 0) from public."QrSigninRecord"));

alter table public."QrSigninRecord"
  alter column version_no set default nextval('qrsigninrecord_version_no_seq'),
  alter column version_no set not null;

alter sequence qrsigninrecord_version_no_seq owned by public."QrSigninRecord".version_no;

create unique index if not exists qrsignin_record_version_no_idx on public."QrSigninRecord" (version_no);

/*
 * 拿掉 is_current 前，必須先移除依賴它的舊 view（QrSigninMeetingSummary 的 join
 * 條件直接寫 r.is_current）。先整個砍掉，drop column 之後再重建——這樣重建時
 * QrSigninRecordCurrent 用 select * 才不會把已經不存在的 is_current 也包進去。
 */
drop view if exists "QrSigninMeetingSummary";
drop view if exists "QrSigninRecordCurrent";

drop index if exists public.qrsignin_record_unique_current_employee;
drop index if exists public.qrsignin_record_unique_current_name_without_employee;
drop index if exists public.qrsignin_record_is_current_idx;
alter table public."QrSigninRecord" drop column if exists is_current;

-- 「目前生效版本」的查詢入口：一人一場只回 version_no 最大的那筆。
create view "QrSigninRecordCurrent" as
select distinct on (meeting_id, coalesce(employee_id, ''), lower(name))
  *
from public."QrSigninRecord"
order by meeting_id, coalesce(employee_id, ''), lower(name), version_no desc;

comment on view "QrSigninRecordCurrent" is
  '每個人在每場會議「目前生效」的那一筆（version_no 最大）；QrSigninRecord 本身允許同一人有多筆歷史版本。';

comment on column public."QrSigninRecord".version_no is
  '全域遞增序號，決定同一人同一場會議「哪一筆是目前生效版本」（取最大值）。取代原本的 is_current 旗標。';

create view "QrSigninMeetingSummary" as
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
left join "QrSigninRecordCurrent" r
  on r.meeting_id = m.id
group by m.id;

comment on view "QrSigninMeetingSummary" is 'QR 簽到後台 Dashboard 場次統計。';

grant select on table public."QrSigninRecordCurrent" to service_role;
grant select on table public."QrSigninMeetingSummary" to service_role;
-- INSERT 依賴 version_no 欄位的 DEFAULT nextval(...)，service_role 沒有這個序號的
-- USAGE 權限就會整個 INSERT 失敗（permission denied for sequence）。
grant usage, select on sequence qrsigninrecord_version_no_seq to service_role;

notify pgrst, 'reload schema';
