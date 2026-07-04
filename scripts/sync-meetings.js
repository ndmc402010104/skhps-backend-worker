#!/usr/bin/env node
/*
同步 prod 會議到 local-dev
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
    console.log('\n🔄 開始同步 prod 會議到 local-dev\n');

    // 1. 清空 local-dev 會議
    console.log('⏳ 清空 local-dev 會議...');
    await supabaseRest(URL, KEY, 'DELETE', '/rest/v1/QrSigninMeeting?env=eq.local-dev');
    console.log('✅ 已清空\n');

    // 2. 查詢 prod 全部會議
    console.log('⏳ 查詢 prod 會議...');
    const meetings = [];
    let offset = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const batch = await supabaseRest(
        URL,
        KEY,
        'GET',
        `/rest/v1/QrSigninMeeting?env=eq.prod&select=*&limit=${pageSize}&offset=${offset}`
      );

      if (!Array.isArray(batch.data) || batch.data.length === 0) {
        hasMore = false;
      } else {
        meetings.push(...batch.data);
        offset += pageSize;
        console.log(`   已查詢 ${meetings.length} 場...`);
      }
    }

    console.log(`✅ 共取得 ${meetings.length} 場會議\n`);

    // 3. 複製會議到 local-dev
    console.log('⏳ 複製會議到 local-dev...');
    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < meetings.length; i++) {
      const meeting = meetings[i];
      // 不改 meeting ID，直接用 prod 的
      // 但改 title 加后缀，这样能避免约束冲突（如果有的话）
      const localMeeting = {
        ...meeting,
        env: 'local-dev',
        title: `${meeting.title}_local${Math.floor(Math.random() * 10000)}`
      };

      const result = await supabaseRest(
        URL,
        KEY,
        'POST',
        '/rest/v1/QrSigninMeeting',
        localMeeting
      );

      if (result.status === 201 || (Array.isArray(result.data) && result.data.length > 0)) {
        successCount++;
      } else {
        errorCount++;
        if (errorCount <= 3) {
          console.log(`   ⚠️  會議 ${i+1} 失敗: HTTP ${result.status}`);
          if (result.data && result.data.message) {
            console.log(`       ${result.data.message}`);
          }
        }
      }

      if ((i + 1) % 10 === 0) {
        console.log(`   進度: ${i + 1}/${meetings.length}...`);
      }
    }

    console.log(`✅ 已複製 ${successCount}/${meetings.length} 場會議 (失敗: ${errorCount})\n`);

    // 4. 驗證
    console.log('⏳ 驗證會議...');
    const verify = await supabaseRest(
      URL,
      KEY,
      'GET',
      '/rest/v1/QrSigninMeeting?env=eq.local-dev&order=starts_at.desc&limit=15'
    );

    if (Array.isArray(verify.data) && verify.data.length > 0) {
      console.log(`✅ local-dev 現在有 ${verify.data.length} 場會議\n`);
      console.log('最新的15場:');
      verify.data.forEach(m => {
        console.log(`  ${m.starts_at} - ${m.ends_at} | ${m.title}`);
      });
    } else {
      console.log('❌ local-dev 會議仍然是空的！');
    }

    console.log('\n🎉 同步完成！');

  } catch (error) {
    console.error('❌ 錯誤:', error.message);
    process.exit(1);
  }
}

main();
