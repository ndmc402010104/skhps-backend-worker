/*
 * 檔案位置：skhps-backend-worker/migrations/20260621_qr_signin_unique_success_only.sql
 * 時間戳記：2026-06-21 21:45 UTC+8
 * 用途：合併同場會議被拆成多個 meeting_id 的資料，並讓同一場會議同一人只限制一筆成功簽到。
 */

drop index if exists public.qrsignin_record_unique_active_employee;
drop index if exists public.qrsignin_record_unique_active_name_without_employee;
drop index if exists public.qrsignin_meeting_unique_identity_active;

with meeting_rank as (
  select
    id,
    first_value(id) over (
      partition by env, title, starts_at, ends_at
      order by created_at asc, id asc
    ) as canonical_id
  from public."QrSigninMeeting"
  where starts_at is not null
    and ends_at is not null
    and status = 'active'
),
duplicate_meeting as (
  select id, canonical_id
  from meeting_rank
  where id <> canonical_id
)
update public."QrSigninRecordAudit" audit
set meeting_id = duplicate_meeting.canonical_id
from duplicate_meeting
where audit.meeting_id = duplicate_meeting.id;

with meeting_rank as (
  select
    id,
    first_value(id) over (
      partition by env, title, starts_at, ends_at
      order by created_at asc, id asc
    ) as canonical_id
  from public."QrSigninMeeting"
  where starts_at is not null
    and ends_at is not null
    and status = 'active'
),
duplicate_meeting as (
  select id, canonical_id
  from meeting_rank
  where id <> canonical_id
)
update public."QrSigninRecord" record
set meeting_id = duplicate_meeting.canonical_id
from duplicate_meeting
where record.meeting_id = duplicate_meeting.id;

with ranked_current as (
  select
    id,
    meeting_id,
    first_value(id) over (
      partition by meeting_id, employee_id
      order by
        case when status in ('signed', 'manual') then 0 else 1 end,
        submitted_at desc,
        created_at desc,
        id desc
    ) as keep_id,
    row_number() over (
      partition by meeting_id, employee_id
      order by
        case when status in ('signed', 'manual') then 0 else 1 end,
        submitted_at desc,
        created_at desc,
        id desc
    ) as rn
  from public."QrSigninRecord"
  where employee_id is not null
    and btrim(employee_id) <> ''
    and status not in ('duplicate', 'void', 'error')
)
insert into public."QrSigninRecordAudit" (
  record_id,
  meeting_id,
  action,
  before_data,
  after_data,
  metadata
)
select
  record.id,
  record.meeting_id,
  'dedupe-current-record',
  to_jsonb(record),
  to_jsonb(record) || jsonb_build_object('status', 'duplicate', 'reason', 'repeated-attempt', 'duplicate_of', ranked_current.keep_id),
  jsonb_build_object('migration', '20260621_qr_signin_unique_success_only', 'duplicateOf', ranked_current.keep_id)
from ranked_current
join public."QrSigninRecord" record on record.id = ranked_current.id
where ranked_current.rn > 1;

with ranked_current as (
  select
    id,
    meeting_id,
    first_value(id) over (
      partition by meeting_id, employee_id
      order by
        case when status in ('signed', 'manual') then 0 else 1 end,
        submitted_at desc,
        created_at desc,
        id desc
    ) as keep_id,
    row_number() over (
      partition by meeting_id, employee_id
      order by
        case when status in ('signed', 'manual') then 0 else 1 end,
        submitted_at desc,
        created_at desc,
        id desc
    ) as rn
  from public."QrSigninRecord"
  where employee_id is not null
    and btrim(employee_id) <> ''
    and status not in ('duplicate', 'void', 'error')
)
update public."QrSigninRecord" record
set
  status = 'duplicate',
  reason = 'repeated-attempt',
  duplicate_of = ranked_current.keep_id,
  metadata = coalesce(record.metadata, '{}'::jsonb)
    || jsonb_build_object('dedupedByMigration', true, 'duplicateOf', ranked_current.keep_id)
from ranked_current
where record.id = ranked_current.id
  and ranked_current.rn > 1;

with ranked_current as (
  select
    id,
    meeting_id,
    first_value(id) over (
      partition by meeting_id, lower(name)
      order by
        case when status in ('signed', 'manual') then 0 else 1 end,
        submitted_at desc,
        created_at desc,
        id desc
    ) as keep_id,
    row_number() over (
      partition by meeting_id, lower(name)
      order by
        case when status in ('signed', 'manual') then 0 else 1 end,
        submitted_at desc,
        created_at desc,
        id desc
    ) as rn
  from public."QrSigninRecord"
  where (employee_id is null or btrim(employee_id) = '')
    and status not in ('duplicate', 'void', 'error')
)
insert into public."QrSigninRecordAudit" (
  record_id,
  meeting_id,
  action,
  before_data,
  after_data,
  metadata
)
select
  record.id,
  record.meeting_id,
  'dedupe-current-record',
  to_jsonb(record),
  to_jsonb(record) || jsonb_build_object('status', 'duplicate', 'reason', 'repeated-attempt', 'duplicate_of', ranked_current.keep_id),
  jsonb_build_object('migration', '20260621_qr_signin_unique_success_only', 'duplicateOf', ranked_current.keep_id)
from ranked_current
join public."QrSigninRecord" record on record.id = ranked_current.id
where ranked_current.rn > 1;

with ranked_current as (
  select
    id,
    meeting_id,
    first_value(id) over (
      partition by meeting_id, lower(name)
      order by
        case when status in ('signed', 'manual') then 0 else 1 end,
        submitted_at desc,
        created_at desc,
        id desc
    ) as keep_id,
    row_number() over (
      partition by meeting_id, lower(name)
      order by
        case when status in ('signed', 'manual') then 0 else 1 end,
        submitted_at desc,
        created_at desc,
        id desc
    ) as rn
  from public."QrSigninRecord"
  where (employee_id is null or btrim(employee_id) = '')
    and status not in ('duplicate', 'void', 'error')
)
update public."QrSigninRecord" record
set
  status = 'duplicate',
  reason = 'repeated-attempt',
  duplicate_of = ranked_current.keep_id,
  metadata = coalesce(record.metadata, '{}'::jsonb)
    || jsonb_build_object('dedupedByMigration', true, 'duplicateOf', ranked_current.keep_id)
from ranked_current
where record.id = ranked_current.id
  and ranked_current.rn > 1;

with meeting_rank as (
  select
    id,
    first_value(id) over (
      partition by env, title, starts_at, ends_at
      order by created_at asc, id asc
    ) as canonical_id
  from public."QrSigninMeeting"
  where starts_at is not null
    and ends_at is not null
    and status = 'active'
),
duplicate_meeting as (
  select id
  from meeting_rank
  where id <> canonical_id
)
delete from public."QrSigninMeeting" meeting
using duplicate_meeting
where meeting.id = duplicate_meeting.id;

create unique index if not exists qrsignin_meeting_unique_identity_active
  on public."QrSigninMeeting" (env, title, starts_at, ends_at)
  where (
    starts_at is not null
    and ends_at is not null
    and status = 'active'
  );

create unique index if not exists qrsignin_record_unique_success_employee
  on public."QrSigninRecord" (meeting_id, employee_id)
  where (
    employee_id is not null
    and btrim(employee_id) <> ''
    and status in ('signed', 'manual')
  );

create unique index if not exists qrsignin_record_unique_success_name_without_employee
  on public."QrSigninRecord" (meeting_id, lower(name))
  where (
    (employee_id is null or btrim(employee_id) = '')
    and status in ('signed', 'manual')
  );

create unique index if not exists qrsignin_record_unique_current_employee
  on public."QrSigninRecord" (meeting_id, employee_id)
  where (
    employee_id is not null
    and btrim(employee_id) <> ''
    and status not in ('duplicate', 'void', 'error')
  );

create unique index if not exists qrsignin_record_unique_current_name_without_employee
  on public."QrSigninRecord" (meeting_id, lower(name))
  where (
    (employee_id is null or btrim(employee_id) = '')
    and status not in ('duplicate', 'void', 'error')
  );

notify pgrst, 'reload schema';
