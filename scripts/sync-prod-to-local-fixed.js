#!/usr/bin/env node
/*
同步 prod 資料到 local-dev - 固定版本
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
    process.exit(1);
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
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : null;
          resolve({ status: res.statusCode, data: parsed, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, data: null });
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
  const URL = vars.SUPABASE_URL;
  const KEY = vars.SUPABASE_SERVICE_ROLE_KEY;

  try {
    console.log('\n🔄 開始同步 prod 資料到 local-dev\n');

    // 1. 清空 local-dev
    console.log('⏳ 清空 local-dev...');
    let result = await supabaseRest(URL, KEY, 'DELETE', '/rest/v1/QrSigninRecord?env=eq.local-dev');
    console.log(`✅ 刪除 local-dev 記錄 (HTTP ${result.status})`);

    // 2. 查詢 prod 簽到記錄
    console.log('\n⏳ 查詢 prod 簽到記錄...');
    const records = [];
    let offset = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const batch = await supabaseRest(
        URL,
        KEY,
        'GET',
        `/rest/v1/QrSigninRecord?env=eq.prod&select=*&limit=${pageSize}&offset=${offset}`
      );

      if (!Array.isArray(batch.data) || batch.data.length === 0) {
        hasMore = false;
      } else {
        records.push(...batch.data);
        offset += pageSize;
        console.log(`   已查詢 ${records.length} 筆...`);
      }
    }

    console.log(`✅ 共取得 ${records.length} 筆簽到記錄\n`);

    // 3. 複製簽到記錄到 local-dev
    console.log('⏳ 複製簽到記錄到 local-dev...');
    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const localRecord = { ...record, env: 'local-dev' };
      
      const result = await supabaseRest(
        URL,
        KEY,
        'POST',
        '/rest/v1/QrSigninRecord',
        localRecord
      );

      if (result.status === 201 || (Array.isArray(result.data) && result.data.length > 0)) {
        successCount++;
      } else {
        errorCount++;
        if (errorCount <= 5) {
          console.log(`   ⚠️  記錄 ${i+1} 失敗: HTTP ${result.status}`);
          if (result.data && result.data.message) {
            console.log(`       ${result.data.message}`);
          }
        }
      }

      if ((i + 1) % 50 === 0) {
        console.log(`   進度: ${i + 1}/${records.length}...`);
      }
    }

    console.log(`✅ 已複製 ${successCount}/${records.length} 筆簽到記錄 (失敗: ${errorCount})\n`);

    // 4. 驗證
    console.log('⏳ 驗證資料...');
    const verify = await supabaseRest(
      URL,
      KEY,
      'GET',
      '/rest/v1/QrSigninRecord?env=eq.local-dev&limit=5'
    );

    if (Array.isArray(verify.data) && verify.data.length > 0) {
      console.log(`✅ local-dev 現在有 ${verify.data.length} 筆記錄`);
      console.log('\n最新的5筆:');
      verify.data.forEach(r => {
        const date = r.signed_at ? r.signed_at.substring(0, 10) : 'NULL';
        console.log(`  ${date} | ${r.source} | ${r.name}`);
      });
    } else {
      console.log('❌ local-dev 仍然是空的！');
    }

    console.log('\n🎉 同步完成！');

  } catch (error) {
    console.error('❌ 錯誤:', error.message);
    process.exit(1);
  }
}

main();
