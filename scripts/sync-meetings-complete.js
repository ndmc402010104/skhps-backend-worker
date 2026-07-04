#!/usr/bin/env node
/*
同步 prod 會議到 local-dev（改 ID，並更新簽到記錄的 meeting_id）
*/

const https = require('https');
const fs = require('fs');
const path = require('path');

function loadDevVars() {
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
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
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
          resolve({ status: res.statusCode, data: parsed });
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
    console.log('\n🔄 開始同步 prod 會議到 local-dev（改 ID 並更新簽到記錄）\n');

    // 1. 清空 local-dev 會議
    console.log('⏳ 清空 local-dev 會議...');
    await supabaseRest(URL, KEY, 'DELETE', '/rest/v1/QrSigninMeeting?env=eq.local-dev');
    console.log('✅ 已清空\n');

    // 2. 查詢 prod 全部會議
    console.log('⏳ 查詢 prod 會議...');
    const prodMeetings = await supabaseRest(
      URL,
      KEY,
      'GET',
      '/rest/v1/QrSigninMeeting?env=eq.prod&select=*'
    );

    if (!Array.isArray(prodMeetings.data)) {
      console.log('❌ 無法查詢會議');
      return;
    }

    console.log(`✅ 共取得 ${prodMeetings.data.length} 場會議\n`);

    // 3. 建立 ID 映射
    const idMapping = {};  // oldId -> newId
    const newMeetings = [];

    for (const meeting of prodMeetings.data) {
      const oldId = meeting.id;
      const newId = generateUUID();
      idMapping[oldId] = newId;
      
      newMeetings.push({
        ...meeting,
        id: newId,
        env: 'local-dev'
      });
    }

    console.log(`📋 建立了 ${Object.keys(idMapping).length} 個 ID 映射\n`);

    // 4. 複製會議到 local-dev
    console.log('⏳ 複製會議到 local-dev...');
    let successCount = 0;

    for (let i = 0; i < newMeetings.length; i++) {
      const meeting = newMeetings[i];
      const result = await supabaseRest(
        URL,
        KEY,
        'POST',
        '/rest/v1/QrSigninMeeting',
        meeting
      );

      if (result.status === 201 || (Array.isArray(result.data) && result.data.length > 0)) {
        successCount++;
      }

      if ((i + 1) % 10 === 0) {
        console.log(`   進度: ${i + 1}/${newMeetings.length}...`);
      }
    }

    console.log(`✅ 已複製 ${successCount}/${newMeetings.length} 場會議\n`);

    // 5. 更新 local-dev 簽到記錄的 meeting_id
    console.log('⏳ 更新簽到記錄的 meeting_id...');
    
    // 查詢 local-dev 中需要更新的簽到記錄
    const localRecords = [];
    let offset = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const batch = await supabaseRest(
        URL,
        KEY,
        'GET',
        `/rest/v1/QrSigninRecord?env=eq.local-dev&select=id,meeting_id&limit=${pageSize}&offset=${offset}`
      );

      if (!Array.isArray(batch.data) || batch.data.length === 0) {
        hasMore = false;
      } else {
        localRecords.push(...batch.data);
        offset += pageSize;
      }
    }

    console.log(`   找到 ${localRecords.length} 筆簽到記錄\n`);

    let updateCount = 0;
    for (const record of localRecords) {
      const oldMeetingId = record.meeting_id;
      const newMeetingId = idMapping[oldMeetingId];

      if (newMeetingId) {
        const result = await supabaseRest(
          URL,
          KEY,
          'PATCH',
          `/rest/v1/QrSigninRecord?id=eq.${record.id}`,
          { meeting_id: newMeetingId }
        );

        if (result.status === 200) {
          updateCount++;
        }
      }
    }

    console.log(`✅ 已更新 ${updateCount}/${localRecords.length} 筆簽到記錄的 meeting_id\n`);

    // 6. 驗證
    console.log('⏳ 驗證會議...');
    const verify = await supabaseRest(
      URL,
      KEY,
      'GET',
      '/rest/v1/QrSigninMeeting?env=eq.local-dev&order=starts_at.desc&limit=10'
    );

    if (Array.isArray(verify.data) && verify.data.length > 0) {
      console.log(`✅ local-dev 現在有 ${verify.data.length} 場會議\n`);
      console.log('最新的10場:');
      verify.data.slice(0, 10).forEach(m => {
        console.log(`  ${m.starts_at} - ${m.ends_at} | ${m.title}`);
      });
    }

    console.log('\n🎉 同步完成！');

  } catch (error) {
    console.error('❌ 錯誤:', error.message);
    process.exit(1);
  }
}

main();
