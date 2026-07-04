/*
 * 檔案位置：skhps-backend-worker/migrations/20260704c_qr_signin_chain_id_for_current_view.sql
 * 時間戳記：2026-07-04
 * 用途：修正 QrSigninRecordCurrent 用 (meeting_id, employee_id, lower(name)) 分組的漏洞。
 *
 * 背景：員編/姓名可能在版本鏈中途被改掉（打字打錯、或「清除修改內容」把打錯的員編
 * 修正回來）。用 employee_id/name 當「同一人」的分組依據，一旦某個版本的 employee_id
 * 跟前後版本不同，view 會把同一條版本鏈拆成兩個不同的人（各自的「最新版本」都會被
 * 當成 current，變成畫面上同一個人出現兩筆）。
 *
 * 修法：改用 chain_id——這是整條版本鏈從第一筆（supersedes_id is null）就決定、
 * 之後每個新版本都原封不動繼承的欄位，不會因為 employee_id/name 被修改而改變。
 * chain_id 是「這條版本鏈是誰」，qr_origin_id 是「這條鏈的 QR 原始基準內容是什麼」——
 * 兩者概念不同：chain_id 一定存在（每筆都有一條鏈可歸屬），qr_origin_id 可以是 null
 * （從沒有真正 QR 簽到過）。
 */

alter table public."QrSigninRecord"
  add column if not exists chain_id uuid;

-- 回填：用 supersedes_id 遞迴往回走，找到每條鏈最早（supersedes_id is null）那一筆的 id。
with recursive chain as (
  select id, id as root_id
  from public."QrSigninRecord"
  where supersedes_id is null
  union all
  select r.id, c.root_id
  from public."QrSigninRecord" r
  join chain c on r.supersedes_id = c.id
)
update public."QrSigninRecord" t
set chain_id = chain.root_id
from chain
where t.id = chain.id and t.chain_id is null;

alter table public."QrSigninRecord"
  alter column chain_id set not null;

create index if not exists qrsignin_record_chain_id_idx on public."QrSigninRecord" (chain_id);

comment on column public."QrSigninRecord".chain_id is
  '整條版本鏈的身分識別：鏈上第一筆（supersedes_id is null）的 id，之後每個新版本原封不動
   繼承，不受 employee_id/name 被修改影響。QrSigninRecordCurrent 用這個分組，不是
   employee_id/name。';

-- QrSigninRecordCurrent 改用 chain_id 分組（原本用 employee_id/name 分組的版本有漏洞）。
drop view if exists "QrSigninMeetingSummary";
drop view if exists "QrSigninRecordCurrent";

create view "QrSigninRecordCurrent" as
select distinct on (meeting_id, chain_id)
  *
from public."QrSigninRecord"
order by meeting_id, chain_id, version_no desc;

comment on view "QrSigninRecordCurrent" is
  '每條版本鏈（chain_id）在每場會議「目前生效」的那一筆（version_no 最大）。';

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

notify pgrst, 'reload schema';
