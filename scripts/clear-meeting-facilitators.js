#!/usr/bin/env node
/*
清除所有 local-dev 會議的主持人設置
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
    console.log('\n🔄 清除所有 local-dev 會議的主持人設置\n');

    // 查詢 local-dev 中的全部會議
    console.log('⏳ 查詢會議...');
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
    console.log('⏳ 清除主持人設置...');

    let clearedCount = 0;
    for (const meeting of meetings.data) {
      const result = await supabaseRest(
        URL,
        KEY,
        'PATCH',
        `/rest/v1/QrSigninMeeting?id=eq.${encodeURIComponent(meeting.id)}&env=eq.local-dev`,
        {
          host_record_id: null,
          recorder_record_id: null
        }
      );

      if (result.status === 200 || result.status === 204) {
        clearedCount++;
      }
    }

    console.log(`\n✅ 完成！已清除 ${clearedCount} 場會議的主持人/記錄者設置\n`);

  } catch (error) {
    console.error('❌ 錯誤:', error.message);
    process.exit(1);
  }
}

main();
