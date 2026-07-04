#!/usr/bin/env node
/*
同步會議主持人和記錄者信息到 local-dev
並設置蔡可威為主持人
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
    console.log('\n🔄 開始同步會議主持人和記錄者\n');

    // 1. 查詢 local-dev 中的全部會議
    console.log('⏳ 查詢 local-dev 會議...');
    const meetings = await supabaseRest(
      URL,
      KEY,
      'GET',
      '/rest/v1/QrSigninMeeting?env=eq.local-dev&select=*&limit=50'
    );

    if (!Array.isArray(meetings.data)) {
      console.log('❌ 無法查詢會議');
      return;
    }

    console.log(`✅ 共取得 ${meetings.data.length} 場會議\n`);

    // 2. 對每個會議，查找蔡可威的簽到記錄
    let updatedCount = 0;

    for (const meeting of meetings.data) {
      console.log(`⏳ 處理會議: ${meeting.title} (${meeting.id})`);

      // 查找蔡可威的簽到記錄
      const records = await supabaseRest(
        URL,
        KEY,
        'GET',
        `/rest/v1/QrSigninRecord?env=eq.local-dev&meeting_id=eq.${encodeURIComponent(meeting.id)}&name=eq.蔡可威&limit=1`
      );

      if (Array.isArray(records.data) && records.data.length > 0) {
        const tsaiRecord = records.data[0];
        console.log(`   找到蔡可威: ${tsaiRecord.name} (${tsaiRecord.id})`);

        // 更新會議的主持人為蔡可威
        const updateResult = await supabaseRest(
          URL,
          KEY,
          'PATCH',
          `/rest/v1/QrSigninMeeting?id=eq.${encodeURIComponent(meeting.id)}&env=eq.local-dev`,
          {
            host_record_id: tsaiRecord.id
          }
        );

        if (updateResult.status === 200 || updateResult.status === 204) {
          console.log(`   ✅ 已設置蔡可威為主持人`);
          updatedCount++;
        } else {
          console.log(`   ❌ 設置主持人失敗 (HTTP ${updateResult.status})`);
        }
      } else {
        console.log(`   ℹ️  本會議無蔡可威`);
      }
      console.log('');
    }

    console.log(`\n✅ 完成！已更新 ${updatedCount} 場會議的主持人\n`);

  } catch (error) {
    console.error('❌ 錯誤:', error.message);
    process.exit(1);
  }
}

main();
