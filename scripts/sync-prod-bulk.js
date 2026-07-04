#!/usr/bin/env node
/*
同步 prod 全部資料到 local-dev - 使用 SQL RPC
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
    console.log('\n🔄 開始同步 prod 全部資料到 local-dev\n');

    // 1. 清空 local-dev
    console.log('⏳ 清空 local-dev...');
    await supabaseRest(URL, KEY, 'DELETE', '/rest/v1/QrSigninRecord?env=eq.local-dev');
    console.log('✅ 已清空\n');

    // 2. 查詢 prod 全部簽到記錄（包括所有狀態）
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

    // 3. 批量插入到 local-dev（忽略重複約束）
    console.log('⏳ 批量插入 local-dev...');
    
    // 準備 CSV 格式的數據
    const columns = Object.keys(records[0]);
    const columnsStr = columns.join(',');
    
    let sqlValues = [];
    for (const record of records) {
      const values = columns.map(col => {
        const val = record[col];
        if (val === null) {
          return 'NULL';
        } else if (typeof val === 'boolean') {
          return val ? 'true' : 'false';
        } else if (typeof val === 'number') {
          return val.toString();
        } else if (typeof val === 'string') {
          // 轉義單引號
          return `'${val.replace(/'/g, "''")}'`;
        } else {
          return `'${JSON.stringify(val)}'`;
        }
      });
      // 修改 env 為 local-dev
      const envIndex = columns.indexOf('env');
      if (envIndex >= 0) {
        values[envIndex] = "'local-dev'";
      }
      sqlValues.push(`(${values.join(',')})`);
    }

    // 分批執行插入（避免超過 URL 長度限制）
    const batchSize = 50;
    let successCount = 0;

    for (let i = 0; i < sqlValues.length; i += batchSize) {
      const batch = sqlValues.slice(i, i + batchSize);
      const sql = `INSERT INTO "QrSigninRecord" (${columnsStr}) VALUES ${batch.join(',')} ON CONFLICT DO NOTHING`;
      
      console.log(`   進度: ${Math.min(i + batchSize, sqlValues.length)}/${sqlValues.length}`);

      // 使用 RPC 或直接 SQL 查詢
      const result = await supabaseRest(
        URL,
        KEY,
        'POST',
        '/rest/v1/rpc/execute_sql',
        { sql }
      );

      if (result.status === 200 || result.status === 201) {
        successCount += batch.length;
      } else if (result.status === 404) {
        // RPC 不存在，試著用另一種方式
        console.log('   ⚠️  RPC 不存在，改用批量 POST...');
        for (const record of records) {
          const localRecord = { ...record, env: 'local-dev' };
          const postResult = await supabaseRest(
            URL,
            KEY,
            'POST',
            '/rest/v1/QrSigninRecord',
            localRecord
          );
          if (postResult.status === 201 || (Array.isArray(postResult.data) && postResult.data.length > 0)) {
            successCount++;
          }
        }
        break;
      }
    }

    console.log(`✅ 已插入 ${successCount}/${records.length} 筆簽到記錄\n`);

    // 4. 驗證
    console.log('⏳ 驗證資料...');
    const verify = await supabaseRest(
      URL,
      KEY,
      'GET',
      '/rest/v1/QrSigninRecord?env=eq.local-dev&order=signed_at.desc&limit=20'
    );

    if (Array.isArray(verify.data) && verify.data.length > 0) {
      console.log(`✅ local-dev 現在有 ${verify.data.length} 筆記錄\n`);
      console.log('最新的20筆:');
      verify.data.forEach(r => {
        const date = r.signed_at ? r.signed_at.substring(0, 10) : 'NULL';
        console.log(`  ${date} | ${r.source} | ${r.name}`);
      });

      // 統計
      console.log('\n📊 記錄統計:');
      const stats = {};
      verify.data.forEach(r => {
        stats[r.source] = (stats[r.source] || 0) + 1;
      });
      Object.entries(stats).forEach(([s, c]) => {
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
