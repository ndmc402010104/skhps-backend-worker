#!/usr/bin/env node
/*
同步 prod 全部資料到 local-dev - 修改 status 避免約束
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
        'Content-Type': 'application/json'
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
    console.log('\n🔄 開始同步 prod 全部資料到 local-dev（改status避免約束）\n');

    // 1. 清空 local-dev
    console.log('⏳ 清空 local-dev...');
    await supabaseRest(URL, KEY, 'DELETE', '/rest/v1/QrSigninRecord?env=eq.local-dev');
    console.log('✅ 已清空\n');

    // 2. 查詢 prod 全部簽到記錄
    console.log('⏳ 查詢 prod 全部簽到記錄...');
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

    // 3. 複製到 local-dev（改 status 為 pending）
    console.log('⏳ 複製到 local-dev（status -> pending）...');
    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const localRecord = {
        ...record,
        env: 'local-dev',
        status: 'pending'  // 改成 pending 避免約束衝突
      };
      
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
      '/rest/v1/QrSigninRecord?env=eq.local-dev&order=signed_at.desc&limit=30'
    );

    if (Array.isArray(verify.data) && verify.data.length > 0) {
      console.log(`✅ local-dev 現在有 ${verify.data.length} 筆記錄\n`);
      console.log('最新的30筆:');
      verify.data.forEach(r => {
        const date = r.signed_at ? r.signed_at.substring(0, 10) : 'NULL';
        console.log(`  ${date} | ${r.source} | ${r.name} | status=${r.status}`);
      });

      // 統計
      console.log('\n📊 Source 統計:');
      const sourceStats = {};
      verify.data.forEach(r => {
        sourceStats[r.source] = (sourceStats[r.source] || 0) + 1;
      });
      Object.entries(sourceStats).forEach(([s, c]) => {
        console.log(`   ${s}: ${c}`);
      });

      console.log('\n📊 Status 統計:');
      const statusStats = {};
      verify.data.forEach(r => {
        statusStats[r.status] = (statusStats[r.status] || 0) + 1;
      });
      Object.entries(statusStats).forEach(([s, c]) => {
        console.log(`   ${s}: ${c}`);
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
