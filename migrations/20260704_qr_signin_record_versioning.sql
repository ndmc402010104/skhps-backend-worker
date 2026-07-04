/*
 * 檔案位置：skhps-backend-worker/migrations/20260704_qr_signin_record_versioning.sql
 * 時間戳記：2026-07-04
 * 用途：QrSigninRecord 改成「每次編輯都 INSERT 新版本」，不再直接 UPDATE 覆蓋原始資料。
 * 背景：
 * - 直接 UPDATE 會讓 signed_at 秒數被砍、reason 被畫面用的確認文字污染，且沒有版本歷史可查。
 * - 「清除修改內容」的還原基準不是「這條版本鏈最早一筆」，而是「這個人這場會議最早一筆真正
 *   source=qr 的自行簽到記錄」——這兩者在「後台先建、QR 後到」的情境下是不同的兩筆，所以
 *   需要獨立的 qr_origin_id 欄位，不能用 supersedes_id 鏈往前走到底代替。
 * - 從沒有真正 QR 簽到過的記錄（例如純手動新增的人員），qr_origin_id 永遠是 null，
 *   前端據此判斷完全不顯示「清除修改內容」。
 */

alter table public."QrSigninRecord"
  add column if not exists is_current boolean not null default true,
  add column if not exists supersedes_id uuid references public."QrSigninRecord" (id),
  add column if not exists qr_origin_id uuid references public."QrSigninRecord" (id);

-- 既有資料回填：is_current 欄位剛新增時預設值 true 會套用到「所有」既有列，
-- 包含 status='duplicate'/'void'/'error' 這些本來就不是「目前生效版本」的列——
-- 這些如果留著 is_current=true，會跟同一人真正生效的那筆一起撞上下面新建的
-- 唯一索引。先把它們改回 false，只有原本符合舊「current」定義的列才維持
-- is_current=true。
update public."QrSigninRecord"
  set is_current = false
  where status in ('duplicate', 'void', 'error');

-- qr_origin_id：既有資料裡 source='qr' 的那筆，qr_origin_id 指向自己；
-- source='admin' 且沒有對應 QR 記錄的維持 null（這類記錄不該有清除功能）。
update public."QrSigninRecord"
  set qr_origin_id = id
  where source = 'qr' and qr_origin_id is null;

create index if not exists qrsignin_record_qr_origin_id_idx on public."QrSigninRecord" (qr_origin_id);
create index if not exists qrsignin_record_supersedes_id_idx on public."QrSigninRecord" (supersedes_id);
create index if not exists qrsignin_record_is_current_idx on public."QrSigninRecord" (meeting_id, is_current);

comment on column public."QrSigninRecord".is_current is
  '這筆是不是這個人在這場會議目前生效的版本；每次編輯都把舊版標 false 並插入新版。';
comment on column public."QrSigninRecord".supersedes_id is
  '指向被這一筆取代的上一個版本；null 表示這是這條鏈最早的一筆（不代表是 QR 原始基準，見 qr_origin_id）。';
comment on column public."QrSigninRecord".qr_origin_id is
  '指向「這個人這場會議最早一筆真正 QR 自行簽到」的 record.id；null 代表從沒有真正 QR 簽到過，
   「清除修改內容」不應顯示。此值一旦設定不會再變（即使後台先建立/修改在前，QR 一出現就定案，
   不會被後續 admin 編輯改掉）。';

-- 拿掉舊的 4 條 status-based 唯一索引（20260704_fix_unique_constraint_by_env.sql），
-- 改成只看 is_current：一人一場一個生效版本，跟 status 是什麼值無關
-- （void/leave 也可以是「目前生效」的那一筆）。
drop index if exists public.qrsignin_record_unique_success_employee;
drop index if exists public.qrsignin_record_unique_success_name_without_employee;
drop index if exists public.qrsignin_record_unique_current_employee;
drop index if exists public.qrsignin_record_unique_current_name_without_employee;

create unique index if not exists qrsignin_record_unique_current_employee
  on public."QrSigninRecord" (env, meeting_id, employee_id)
  where (
    is_current
    and employee_id is not null
    and btrim(employee_id) <> ''
  );

create unique index if not exists qrsignin_record_unique_current_name_without_employee
  on public."QrSigninRecord" (env, meeting_id, lower(name))
  where (
    is_current
    and (employee_id is null or btrim(employee_id) = '')
  );

-- QrSigninMeetingSummary 一定要重新指向 is_current，否則同一人有多筆版本時
-- dashboard 統計會重複計算。
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
  and r.is_current
group by m.id;
