/*
檔案：check-qr-signin-data-issues.sql
用途：檢查 local-dev 環境中所有的簽到記錄，識別不合理的後台修改
在 Supabase SQL 編輯器中執行此查詢
*/

-- 1. 統計 local-dev 環境中 QR 記錄的數量和來源分布
SELECT 
  'QrSigninRecord 統計' AS "檢查項目",
  env,
  source,
  COUNT(*) as "筆數"
FROM "QrSigninRecord"
WHERE env = 'local-dev'
GROUP BY env, source
ORDER BY source;

-- 2. 找出所有 source='admin' 的記錄，並顯示其詳細信息
SELECT 
  r.id,
  r.meeting_id,
  m.title as "會議",
  m.meeting_date as "日期",
  r.name as "簽到人員",
  r.employee_id as "員編",
  r.role as "職級",
  r.signed_at as "簽到時間",
  r.status as "狀態",
  r.source as "來源",
  r.updated_at as "最後更新",
  r.updated_by as "更新者"
FROM "QrSigninRecord" r
LEFT JOIN "QrSigninMeeting" m ON r.meeting_id = m.id
WHERE r.env = 'local-dev' AND r.source = 'admin'
ORDER BY r.updated_at DESC;

-- 3. 找出所有 source='qr' 的原始記錄（用來對比）
SELECT 
  r.id,
  r.meeting_id,
  m.title as "會議",
  m.meeting_date as "日期",
  r.name as "簽到人員",
  r.employee_id as "員編",
  r.role as "職級",
  r.signed_at as "簽到時間",
  r.status as "狀態",
  r.created_at as "建檔時間"
FROM "QrSigninRecord" r
LEFT JOIN "QrSigninMeeting" m ON r.meeting_id = m.id
WHERE r.env = 'local-dev' AND r.source = 'qr'
ORDER BY r.created_at DESC;

-- 4. 對於每個會議，顯示同一人員的 QR 記錄和 admin 修改記錄
SELECT 
  m.title as "會議",
  m.meeting_date as "日期",
  r.name as "人員",
  r.employee_id as "員編",
  STRING_AGG(r.source, ', ') as "所有來源",
  COUNT(*) as "記錄筆數",
  STRING_AGG(DISTINCT r.status, ', ') as "所有狀態"
FROM "QrSigninRecord" r
LEFT JOIN "QrSigninMeeting" m ON r.meeting_id = m.id
WHERE r.env = 'local-dev'
GROUP BY m.title, m.meeting_date, r.name, r.employee_id
HAVING COUNT(*) > 1
ORDER BY m.meeting_date DESC, r.name;

-- 5. 查看 Audit 日誌中對 admin 記錄做的操作
SELECT 
  a.record_id,
  a.action as "操作",
  a.actor_name as "操作者",
  a.created_at as "操作時間",
  a.note as "備註"
FROM "QrSigninRecordAudit" a
WHERE a.record_id IN (
  SELECT r.id FROM "QrSigninRecord" r 
  WHERE r.env = 'local-dev' AND r.source = 'admin'
)
ORDER BY a.created_at DESC
LIMIT 50;
