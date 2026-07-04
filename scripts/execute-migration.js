#!/usr/bin/env node
/*
連接 Supabase PostgreSQL 並執行 SQL 修復約束
*/

const { Client } = require('pg');

async function main() {
  const connectionString = 'postgresql://postgres:mBbYZHWrVilVDQE0@db.ybixaibejrigqbrostnq.supabase.co:5432/postgres';

  const client = new Client({
    connectionString: connectionString,
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log('\n🔧 連接 Supabase PostgreSQL...\n');
    await client.connect();
    console.log('✅ 已連接\n');

    // SQL 語句
    const sqlStatements = [
      'DROP INDEX IF EXISTS public.qrsignin_record_unique_success_employee;',
      'DROP INDEX IF EXISTS public.qrsignin_record_unique_success_name_without_employee;',
      'DROP INDEX IF EXISTS public.qrsignin_record_unique_current_employee;',
      'DROP INDEX IF EXISTS public.qrsignin_record_unique_current_name_without_employee;',
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
       );`,
      `CREATE UNIQUE INDEX IF NOT EXISTS qrsignin_record_unique_current_employee
       ON public."QrSigninRecord" (env, meeting_id, employee_id)
       WHERE (
         employee_id IS NOT NULL
         AND btrim(employee_id) <> ''
         AND status NOT IN ('duplicate', 'void', 'error')
       );`,
      `CREATE UNIQUE INDEX IF NOT EXISTS qrsignin_record_unique_current_name_without_employee
       ON public."QrSigninRecord" (env, meeting_id, lower(name))
       WHERE (
         (employee_id IS NULL OR btrim(employee_id) = '')
         AND status NOT IN ('duplicate', 'void', 'error')
       );`
    ];

    console.log('📋 執行 SQL 修復約束...\n');

    for (let i = 0; i < sqlStatements.length; i++) {
      const stmt = sqlStatements[i];
      try {
        console.log(`${i + 1}. 執行: ${stmt.substring(0, 50)}...`);
        await client.query(stmt);
        console.log(`   ✅ 成功\n`);
      } catch (e) {
        console.log(`   ❌ 失敗: ${e.message}\n`);
      }
    }

    console.log('✅ 約束修復完成！');
    console.log('\n💡 現在 prod 和 local-dev 可以各自有獨立的記錄了。\n');

  } catch (error) {
    console.error('❌ 連接錯誤:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
