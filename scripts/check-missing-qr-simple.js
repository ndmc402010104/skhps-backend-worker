#!/usr/bin/env node
/*
簡化版本：查詢所有 source=qr 和 source=admin 的記錄，看誰少了什麼
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
    console.error('❌ 無法讀取 .dev.vars');
    return null;
  }
}

function supabaseRest(url, key, method, path) {
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
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(null);
        }
      });
    });

    req.on('error', reject);
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

  try {
    console.log('\n📊 查詢 local-dev 的簽到記錄...\n');

    // 查詢所有 source=qr 的記錄
    const qrRecords = await supabaseRest(
      URL,
      KEY,
      'GET',
      `/rest/v1/QrSigninRecord?env=eq.local-dev&source=eq.qr&select=name,employee_id,role`
    );

    // 查詢所有 source=admin 的記錄
    const adminRecords = await supabaseRest(
      URL,
      KEY,
      'GET',
      `/rest/v1/QrSigninRecord?env=eq.local-dev&source=eq.admin&select=name,employee_id,role`
    );

    console.log(`✅ QR 簽到記錄（source=qr）: ${Array.isArray(qrRecords) ? qrRecords.length : 0} 筆`);
    if (Array.isArray(qrRecords)) {
      console.table(qrRecords.slice(0, 15).map(r => ({ 人員: r.name, 員編: r.employee_id, 職級: r.role })));
    }

    console.log(`\n❌ 後台記錄（source=admin）: ${Array.isArray(adminRecords) ? adminRecords.length : 0} 筆`);
    if (Array.isArray(adminRecords)) {
      console.table(adminRecords.map(r => ({ 人員: r.name, 員編: r.employee_id, 職級: r.role })));
    }

    // 檢查：哪些 admin 記錄沒有對應的 QR 記錄
    if (Array.isArray(adminRecords) && Array.isArray(qrRecords)) {
      const adminSet = new Set(adminRecords.map(r => `${r.name}|${r.employee_id}`));
      const qrSet = new Set(qrRecords.map(r => `${r.name}|${r.employee_id}`));

      const onlyAdmin = Array.from(adminSet).filter(key => !qrSet.has(key));

      if (onlyAdmin.length > 0) {
        console.log('\n⚠️  純後台記錄（沒有原始 QR 簽到）：');
        onlyAdmin.forEach(key => {
          const [name, empNo] = key.split('|');
          console.log(`  - ${name} (${empNo})`);
        });
        console.log('\n💡 這些人員應該保持 source="admin"，因為他們沒有 QR 掃碼記錄');
      } else {
        console.log('\n✅ 所有 admin 記錄都有對應的 QR 掃碼記錄');
      }
    }

  } catch (error) {
    console.error('❌ 錯誤:', error.message);
  }
}

main();
