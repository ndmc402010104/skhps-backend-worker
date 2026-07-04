#!/usr/bin/env node
/*
檢查特定人員的所有簽到記錄，看他是否真的有 QR 掃碼記錄
*/

const https = require('https');
const fs = require('fs');
const path = require('path');

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
            reject(new Error(`HTTP ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`解析回應失敗`));
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
    console.error('❌ 缺少 SUPABASE 憑證');
    process.exit(1);
  }

  const URL = vars.SUPABASE_URL;
  const KEY = vars.SUPABASE_SERVICE_ROLE_KEY;
  const TABLE = 'QrSigninRecord';

  try {
    console.log('\n🔍 檢查所有人員的 QR 記錄情況...\n');

    // 查詢所有人員的 source 分布
    const allRecords = await supabaseRest(
      URL,
      KEY,
      'GET',
      `/rest/v1/${TABLE}?env=eq.local-dev&select=name,employee_id,source,count()&limit=1000`
    );

    // 查詢 source=admin 但沒有對應 QR 記錄的人員
    const adminRecords = await supabaseRest(
      URL,
      KEY,
      'GET',
      `/rest/v1/${TABLE}?env=eq.local-dev&source=eq.admin&select=id,name,employee_id,role,source&limit=1000`
    );

    console.log('📊 source=admin 的所有記錄：\n');
    console.table(adminRecords.map(r => ({
      '人員': r.name,
      '員編': r.employee_id,
      '職級': r.role,
      '來源': r.source
    })));

    // 對於每個 admin 記錄，查詢是否有對應的 QR 記錄
    console.log('\n🔎 檢查這些人員是否有 QR 掃碼記錄：\n');

    for (const admin of adminRecords) {
      const qrRecords = await supabaseRest(
        URL,
        KEY,
        'GET',
        `/rest/v1/${TABLE}?env=eq.local-dev&employee_id=eq.${encodeURIComponent(admin.employee_id || '')}&name=eq.${encodeURIComponent(admin.name)}&source=eq.qr&select=id,source`
      );

      const status = Array.isArray(qrRecords) && qrRecords.length > 0 ? '✅ 有 QR 記錄' : '❌ 沒有 QR 記錄（純後台補登）';
      console.log(`${status} - ${admin.name} (${admin.employee_id})`);
    }

    console.log('\n💡 結論：');
    console.log('- ❌ 沒有 QR 記錄的人員，應該保持 source="admin"');
    console.log('- ✅ 有 QR 記錄的人員，才能享受新邏輯的智能判斷\n');

  } catch (error) {
    console.error('❌ 錯誤:', error.message);
    process.exit(1);
  }
}

main();
