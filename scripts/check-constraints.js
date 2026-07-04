#!/usr/bin/env node
/*
检查并修改 Supabase 约束条件
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
    console.log('\n🔍 查詢 Supabase 約束條件...\n');

    // 使用 RPC 查询约束
    const result = await supabaseRest(
      URL,
      KEY,
      'GET',
      `/rest/v1/information_schema.table_constraints?table_name=eq.QrSigninRecord&constraint_type=eq.UNIQUE`
    );

    if (Array.isArray(result.data) && result.data.length > 0) {
      console.log('📋 找到的UNIQUE約束:');
      result.data.forEach(c => {
        console.log(`  - ${c.constraint_name}`);
      });

      // 查詢具體的約束欄位
      console.log('\n🔎 查詢約束詳細...');
      const colRes = await supabaseRest(
        URL,
        KEY,
        'GET',
        `/rest/v1/information_schema.constraint_column_usage?table_name=eq.QrSigninRecord`
      );

      if (Array.isArray(colRes.data)) {
        colRes.data.forEach(c => {
          console.log(`  ${c.constraint_name}: ${c.column_name}`);
        });
      }
    } else {
      console.log('❌ 無法查詢約束信息');
    }

    // 查詢表的定義
    console.log('\n📊 查詢表結構...');
    const tableRes = await supabaseRest(
      URL,
      KEY,
      'GET',
      `/rest/v1/information_schema.tables?table_name=eq.QrSigninRecord`
    );

    if (Array.isArray(tableRes.data)) {
      tableRes.data.forEach(t => {
        console.log(`  表: ${t.table_name}`);
        console.log(`  Schema: ${t.table_schema}`);
      });
    }

  } catch (error) {
    console.error('❌ 錯誤:', error.message);
  }
}

main();
