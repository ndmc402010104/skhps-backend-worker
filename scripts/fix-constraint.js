#!/usr/bin/env node
/*
在 Supabase 通过 SQL 执行约束修复
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

    // SQL 語句：刪除舊約束並建立新的（帶 env 條件）
    const sqlStatements = [
      'DROP INDEX IF EXISTS public.qrsignin_record_unique_success_employee;',
      'DROP INDEX IF EXISTS public.qrsignin_record_unique_success_name_without_employee;',
      `CREATE UNIQUE INDEX IF NOT EXISTS qrsignin_record_unique_success_employee
       ON public."QrSigninRecord" (env, meeting_id, employee_id)
       WHERE (
         employee_id IS NOT NULL
         AND btrim(employee_id) <> ''
         AND status IN ('signed', 'manual')
       );`,
      `CREATE UNIQUE INDEX IF NOT EXISTS qrsignin_record_unique_success_name_without_employee
       ON public."QrSigninRecord" (env, meeting_id, lower(name))
       WHERE (
         (employee_id IS NULL OR btrim(employee_id) = '')
         AND status IN ('signed', 'manual')
       );`
    ];

    console.log('📋 將執行以下操作：');
    sqlStatements.forEach((stmt, i) => {
      console.log(`\n${i + 1}. ${stmt.substring(0, 60)}...`);
    });

    console.log('\n\n💡 為了在 Supabase 上執行這些 SQL，請到以下位置手動執行：');
    console.log('   1. 打開 Supabase 控制板: ' + URL);
    console.log('   2. 進入 SQL Editor');
    console.log('   3. 複製以下 SQL 並執行：\n');
    console.log('------- 開始複製 -------\n');
    
    sqlStatements.forEach(stmt => {
      console.log(stmt);
      console.log('');
    });
    
    console.log('------- 結束複製 -------\n');

    // 试图通过某种方式执行
    console.log('⏳ 嘗試通過 Supabase API 執行...\n');

    // 检查是否有现成的 RPC
    const rpcCheck = await supabaseRest(
      URL,
      KEY,
      'GET',
      '/rest/v1/rpc?select=*&function_name=like.*fix*'
    );

    console.log('📡 查詢 RPC 結果:', rpcCheck.status);

    // 如果没有 RPC，建议用户手动执行
    console.log('\n💪 請在 Supabase SQL Editor 中執行上面的 SQL。\n');
    console.log('執行完成後，約束將被修復，prod 和 local-dev 的資料就不會相互衝突了。');

  } catch (error) {
    console.error('❌ 錯誤:', error.message);
  }
}

main();
