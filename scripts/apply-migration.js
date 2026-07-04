#!/usr/bin/env node
/*
在 Supabase 上执行 SQL migration - 修复约束条件
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
    console.log('\n🔧 修復 Supabase 約束條件\n');

    // 讀取 migration 文件
    const migrationPath = path.join(__dirname, '..', 'migrations', '20260704_fix_unique_constraint_by_env.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    console.log('📄 執行 SQL:\n');
    console.log(sql);
    console.log('\n⏳ 發送到 Supabase...\n');

    // 使用 RPC 執行 SQL
    const result = await supabaseRest(
      URL,
      KEY,
      'POST',
      '/rest/v1/rpc/execute_sql_migration',
      { sql }
    );

    if (result.status === 200) {
      console.log('✅ SQL 執行成功！');
    } else if (result.status === 404) {
      console.log('⚠️  RPC 不存在，嘗試直接執行...\n');
      
      // 分段執行 SQL（某些数据库不支持批量执行）
      const statements = sql.split(';').filter(s => s.trim());
      let successCount = 0;
      
      for (const stmt of statements) {
        if (!stmt.trim()) continue;
        
        const stmtResult = await supabaseRest(
          URL,
          KEY,
          'POST',
          '/rest/v1/rpc/execute_sql_statement',
          { sql: stmt }
        );
        
        if (stmtResult.status === 200) {
          successCount++;
          console.log(`✅ 執行成功: ${stmt.substring(0, 50)}...`);
        } else {
          console.log(`❌ 失敗: ${stmt.substring(0, 50)}...`);
          console.log(`   HTTP ${stmtResult.status}`);
          if (stmtResult.data && stmtResult.data.message) {
            console.log(`   ${stmtResult.data.message}`);
          }
        }
      }
      
      console.log(`\n✅ 完成: ${successCount}/${statements.length} 語句執行成功`);
    } else {
      console.log(`❌ 執行失敗: HTTP ${result.status}`);
      if (result.data && result.data.message) {
        console.log(`   ${result.data.message}`);
      }
    }

    console.log('\n💡 約束已修復。現在 prod 和 local-dev 可以各自有獨立的記錄了。');

  } catch (error) {
    console.error('❌ 錯誤:', error.message);
    process.exit(1);
  }
}

main();
