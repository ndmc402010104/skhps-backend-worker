#!/usr/bin/env node
/*
刪除孤兒記錄
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
    return null;
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

async function main() {
  const vars = loadDevVars();
  const URL = vars.SUPABASE_URL;
  const KEY = vars.SUPABASE_SERVICE_ROLE_KEY;

  try {
    console.log('\n🗑️ 刪除孤兒記錄\n');

    const orphanRecords = [
      { name: '陳若蓉', empNo: 'R014514', recordId: 'd40efea8-f490-427a-a973-b652e9c5300d' },
      { name: '蔡可威', empNo: 'M013423', recordId: 'cab04fdf-6edf-44a4-bb76-01ec5401897c' },
      { name: '林享辰', empNo: 'M018094', recordId: 'be2fbd77-24c9-4a9d-bcba-642d97e04b6d' }
    ];

    for (const person of orphanRecords) {
      console.log(`⏳ 刪除 ${person.name}...`);
      
      // 刪除記錄
      const result = await supabaseRest(
        URL,
        KEY,
        'DELETE',
        `/rest/v1/QrSigninRecord?id=eq.${person.recordId}`
      );

      console.log(`✅ ${person.name} 已刪除\n`);
    }

    console.log('🎉 完成！孤兒記錄已清理');

  } catch (error) {
    console.error('❌ 錯誤:', error.message);
  }
}

main();
