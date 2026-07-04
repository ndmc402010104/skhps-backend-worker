-- 查詢所有表
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name LIKE '%qr%'
ORDER BY table_name;
