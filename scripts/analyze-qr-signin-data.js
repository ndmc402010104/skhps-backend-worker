#!/usr/bin/env node
/*
檔案：scripts/analyze-qr-signin-data.js
用途：分析 local-dev 環境中的簽到記錄，找出不合理的後台修改
運行：node scripts/analyze-qr-signin-data.js
*/

const https = require('https');
const fs = require('fs');
const path = require('path');

// 讀取 .dev.vars
function loadDevVars() {
  try {
    const devVarsPath = path.join(__dirname, '..', '.dev.vars');
    const content = fs.readFileSync(devVarsPath, 'utf-8');
    const vars = {};
    content.split('\n').forEach(line => {
      const [key, ...rest] = line.split('=');
      if (key && rest.length > 0) {
        vars[key.trim()] = rest.join('=').trim().replace(/^["']|["']$/g, '');
      }
    });
    return vars;
  } catch (error) {
    console.error('❌ 無法讀取 .dev.vars:', error.message);
    return null;
  }
}

function supabaseQuery(url, key, query) {
  return new Promise((resolve, reject) => {
    const queryStr = encodeURIComponent(query);
    const apiUrl = new URL(
      `${url}/rest/v1/rpc/sql?query=${queryStr}`,
      url
    );

    const options = {
      hostname: apiUrl.hostname,
      path: apiUrl.pathname + apiUrl.search,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${key}`,
        'apikey': key,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`解析回應失敗: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function main() {
  console.log('\n📊 分析 QR 簽到記錄...\n');

  const vars = loadDevVars();
  if (!vars || !vars.SUPABASE_URL || !vars.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ 缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const URL = vars.SUPABASE_URL;
  const KEY = vars.SUPABASE_SERVICE_ROLE_KEY;

  try {
    // 1. 統計來源分布
    console.log('⏳ 查詢簽到記錄統計...');
    const statsQuery = `
      SELECT source, COUNT(*) as count 
      FROM "QrSigninRecord" 
      WHERE env = 'local-dev' 
      GROUP BY source 
      ORDER BY source
    `;
    
    // 簡單的 Supabase HTTP API 查詢方式
    const statsUrl = `${URL}/rest/v1/QrSigninRecord?select=source&env=eq.local-dev&limit=10000`;
    
    console.log('\n✅ 建議檢查方案：\n');
    console.log('1️⃣ 到 Supabase 管理後台的 SQL 編輯器');
    console.log('2️⃣ 複製並執行以下 SQL 查詢文件中的查詢：');
    console.log('   📄 check-qr-signin-data-issues.sql\n');
    console.log('3️⃣ 查看結果後，執行以下清理 SQL：\n');

    const cleanupSql = `
-- 將所有 local-dev 環境中不合理的 admin 記錄改回 qr
-- ⚠️ 運行前請先用查詢驗證這些記錄
UPDATE "QrSigninRecord"
SET source = 'qr'
WHERE env = 'local-dev' 
  AND source = 'admin'
  AND updated_at IS NOT NULL;

-- 查詢剛才更新了多少筆記錄
SELECT COUNT(*) as "修改筆數"
FROM "QrSigninRecord"
WHERE env = 'local-dev' AND source = 'qr';
    `;

    console.log('📝 清理 SQL 命令：\n');
    console.log(cleanupSql);
    console.log('\n💡 或者，如果你想更細粒度的控制，可以執行：\n');

    const granularSql = `
-- 只改回那些內容與原始記錄相同的 admin 記錄
-- （這需要更複雜的邏輯，建議等新代碼運行一次後再做）
WITH original_records AS (
  SELECT DISTINCT ON (meeting_id, employee_id) *
  FROM "QrSigninRecord"
  WHERE env = 'local-dev' AND source = 'qr'
  ORDER BY meeting_id, employee_id, created_at
)
UPDATE "QrSigninRecord" r
SET source = 'qr'
FROM original_records o
WHERE r.env = 'local-dev'
  AND r.source = 'admin'
  AND r.meeting_id = o.meeting_id
  AND r.employee_id = o.employee_id
  AND r.name = o.name
  AND r.role = o.role
  AND (r.signed_at AT TIME ZONE 'UTC')::date = (o.signed_at AT TIME ZONE 'UTC')::date;
    `;

    console.log(granularSql);

  } catch (error) {
    console.error('❌ 錯誤:', error.message);
    process.exit(1);
  }
}

main();
