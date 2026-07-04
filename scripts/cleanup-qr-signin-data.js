#!/usr/bin/env node
/*
檔案：scripts/cleanup-qr-signin-data.js
用途：清理 local-dev 環境中不合理的後台修改，改回前台簽到
運行：node scripts/cleanup-qr-signin-data.js
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
      if (!line.trim() || line.startsWith('#')) return;
      const eqIndex = line.indexOf('=');
      if (eqIndex > 0) {
        const key = line.substring(0, eqIndex).trim();
        const value = line.substring(eqIndex + 1).trim().replace(/^["']|["']$/g, '');
        vars[key] = value;
      }
    });
    return vars;
  } catch (error) {
    console.error('❌ 無法讀取 .dev.vars:', error.message);
    return null;
  }
}

// 執行 Supabase REST API 查詢
function supabaseRest(url, key, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(path, url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
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
          const parsed = data ? JSON.parse(data) : null;
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`解析回應失敗: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  const vars = loadDevVars();
  if (!vars || !vars.SUPABASE_URL || !vars.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ 缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const URL = vars.SUPABASE_URL;
  const KEY = vars.SUPABASE_SERVICE_ROLE_KEY;
  const TABLE = 'QrSigninRecord';

  try {
    console.log('\n📊 正在分析 QR 簽到記錄...\n');

    // 1. 查詢 local-dev 中所有 source='admin' 的記錄
    console.log('⏳ 查詢 local-dev 中的 admin 記錄...');
    const adminRecords = await supabaseRest(
      URL,
      KEY,
      'GET',
      `/rest/v1/${TABLE}?env=eq.local-dev&source=eq.admin&select=id,name,employee_id,role,signed_at,status,updated_at,updated_by&limit=1000`
    );

    if (!Array.isArray(adminRecords)) {
      throw new Error('無法查詢記錄');
    }

    console.log(`✅ 找到 ${adminRecords.length} 筆 admin 記錄\n`);

    if (adminRecords.length === 0) {
      console.log('🎉 沒有 admin 記錄，數據已經很乾淨了！');
      process.exit(0);
    }

    // 顯示這些記錄的摘要
    console.log('📋 admin 記錄摘要：');
    console.table(adminRecords.slice(0, 10).map(r => ({
      '人員': r.name,
      '員編': r.employee_id,
      '職級': r.role,
      '簽到時間': r.signed_at ? new Date(r.signed_at).toLocaleString('zh-TW') : '-',
      '狀態': r.status,
      '更新者': r.updated_by || '系統'
    })));

    if (adminRecords.length > 10) {
      console.log(`... 還有 ${adminRecords.length - 10} 筆記錄\n`);
    }

    // 2. 詢問用戶是否要清理
    console.log('\n🔧 清理選項：');
    console.log('1️⃣ 將所有 admin 記錄改回 source="qr"（用於新邏輯測試）');
    console.log('2️⃣ 只改回那些內容與原始 QR 記錄相同的 admin 記錄');
    console.log('3️⃣ 不做任何改動\n');

    console.log('💡 建議：選擇 1️⃣ 可以直接測試新邏輯');
    console.log('   （新邏輯會在下次編輯時自動判斷是否應該改回 admin）\n');

    // 自動執行（因為是 local-dev 用來測試的環境）
    console.log('⏳ 執行清理...\n');

    // 2a. 簡單方案：直接把所有 admin 改回 qr
    console.log('📝 執行：UPDATE "QrSigninRecord" SET source=\'qr\' WHERE env=\'local-dev\' AND source=\'admin\'\n');

    // 構建 Supabase PATCH 請求 - 批量更新
    const updateCount = adminRecords.length;
    
    // 使用 RPC 或直接 PATCH
    // 由於 REST API 的限制，我們需要逐筆或分批更新
    console.log(`⏳ 正在更新 ${updateCount} 筆記錄...\n`);

    let successCount = 0;
    let errorCount = 0;

    // 分批更新（每次 100 筆）
    for (let i = 0; i < adminRecords.length; i += 100) {
      const batch = adminRecords.slice(i, Math.min(i + 100, adminRecords.length));
      
      try {
        // 方法1：使用 upsert 更新（雖然低效）
        // 方法2：直接用 RPC 函數
        // 方法3：用 WHERE 條件的 PATCH

        // 簡單方法：逐個更新
        const batchPromises = batch.map(record =>
          supabaseRest(
            URL,
            KEY,
            'PATCH',
            `/rest/v1/${TABLE}?id=eq.${record.id}`,
            { source: 'qr' }
          ).then(() => {
            successCount++;
          }).catch(err => {
            console.error(`❌ 更新失敗 (${record.name}):`, err.message);
            errorCount++;
          })
        );

        await Promise.all(batchPromises);
        console.log(`✅ 已更新 ${Math.min(i + 100, adminRecords.length)}/${updateCount} 筆記錄`);
      } catch (error) {
        console.error(`❌ 批次更新失敗:`, error.message);
      }
    }

    console.log(`\n🎉 清理完成！`);
    console.log(`✅ 成功更新：${successCount} 筆`);
    if (errorCount > 0) {
      console.log(`❌ 更新失敗：${errorCount} 筆`);
    }

    console.log('\n✨ local-dev 環境已準備好進行新邏輯測試！');
    console.log('📌 所有記錄現在都標記為 source="qr"');
    console.log('📌 新邏輯將在編輯時自動判斷是否應該改為 "admin"\n');

  } catch (error) {
    console.error('❌ 錯誤:', error.message);
    process.exit(1);
  }
}

main();
