#!/usr/bin/env node
/*
同步 prod 資料到 local-dev
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
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(null);
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function deletePatch(env, url, key, table, filter) {
  const response = await supabaseRest(
    url,
    key,
    'DELETE',
    `${table}?${filter}`
  );
  return response;
}

async function main() {
  const vars = loadDevVars();
  const URL = vars.SUPABASE_URL;
  const KEY = vars.SUPABASE_SERVICE_ROLE_KEY;

  try {
    console.log('\n🔄 開始同步 prod 資料到 local-dev\n');

    // 1. 清空 local-dev
    console.log('⏳ 清空 local-dev 審計記錄...');
    await supabaseRest(URL, KEY, 'DELETE', '/rest/v1/QrSigninRecordAudit?record_id=in.(SELECT%20id%20FROM%20QrSigninRecord%20WHERE%20env=%27local-dev%27)');
    console.log('✅ 審計記錄已清空');

    console.log('⏳ 清空 local-dev 簽到記錄...');
    await supabaseRest(URL, KEY, 'DELETE', '/rest/v1/QrSigninRecord?env=eq.local-dev');
    console.log('✅ 簽到記錄已清空');

    console.log('⏳ 清空 local-dev 會議...');
    await supabaseRest(URL, KEY, 'DELETE', '/rest/v1/QrSigninMeeting?env=eq.local-dev');
    console.log('✅ 會議已清空\n');

    // 2. 查詢 prod 會議
    console.log('⏳ 查詢 prod 會議...');
    const prodMeetings = await supabaseRest(
      URL,
      KEY,
      'GET',
      '/rest/v1/QrSigninMeeting?env=eq.prod&select=*'
    );

    if (!Array.isArray(prodMeetings)) {
      console.error('❌ 無法查詢 prod 會議');
      return;
    }

    console.log(`   找到 ${prodMeetings.length} 場會議\n`);

    // 3. 複製會議
    console.log('⏳ 複製會議到 local-dev...');
    let meetingCount = 0;
    for (const meeting of prodMeetings) {
      const localMeeting = { ...meeting, env: 'local-dev' };
      const result = await supabaseRest(
        URL,
        KEY,
        'POST',
        '/rest/v1/QrSigninMeeting',
        localMeeting
      );
      if (result && !result.error) {
        meetingCount++;
      }
    }
    console.log(`✅ 已複製 ${meetingCount}/${prodMeetings.length} 場會議\n`);

    // 4. 查詢 prod 簽到記錄
    console.log('⏳ 查詢 prod 簽到記錄（分頁）...');
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

      if (!Array.isArray(batch) || batch.length === 0) {
        hasMore = false;
      } else {
        records.push(...batch);
        offset += pageSize;
        console.log(`   已查詢 ${records.length} 筆...`);
      }
    }

    console.log(`   共 ${records.length} 筆簽到記錄\n`);

    // 5. 複製簽到記錄
    console.log('⏳ 複製簽到記錄到 local-dev...');
    let recordCount = 0;
    for (const record of records) {
      const localRecord = { ...record, env: 'local-dev' };
      const result = await supabaseRest(
        URL,
        KEY,
        'POST',
        '/rest/v1/QrSigninRecord',
        localRecord
      );
      if (result && !result.error) {
        recordCount++;
      }
    }
    console.log(`✅ 已複製 ${recordCount}/${records.length} 筆簽到記錄\n`);

    // 6. 驗證
    console.log('⏳ 驗證資料...');
    const verification = await supabaseRest(
      URL,
      KEY,
      'GET',
      '/rest/v1/QrSigninRecord?env=eq.local-dev&select=source,count=count()'
    );

    if (Array.isArray(verification)) {
      console.log('📊 local-dev 簽到記錄來源分布：');
      verification.forEach(v => {
        console.log(`   ${v.source || 'unknown'}: ${v.count} 筆`);
      });
    }

    console.log('\n🎉 同步完成！');

  } catch (error) {
    console.error('❌ 錯誤:', error.message);
    process.exit(1);
  }
}

main();
