#!/usr/bin/env node
/*
修正：把沒有原始 QR 簽到的人員改回 source=admin
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
  const TABLE = 'QrSigninRecord';

  try {
    console.log('\n🔧 修正：把沒有原始 QR 簽到的人員改回 admin\n');

    // 這三個人沒有 QR 簽到，只有後台補登
    const noQrPeople = [
      { name: '陳若臻', empNo: 'R014514' },
      { name: '蔡可威', empNo: 'M013423' },
      { name: '林享辰', empNo: 'M018094' }
    ];

    for (const person of noQrPeople) {
      console.log(`⏳ 修正 ${person.name} (${person.empNo})...`);
      
      // 找出該人員的所有記錄
      const records = await supabaseRest(
        URL,
        KEY,
        'GET',
        `/rest/v1/${TABLE}?env=eq.local-dev&employee_id=eq.${person.empNo}&select=id,source`
      );

      if (Array.isArray(records)) {
        for (const record of records) {
          // 改回 admin
          await supabaseRest(
            URL,
            KEY,
            'PATCH',
            `/rest/v1/${TABLE}?id=eq.${record.id}`,
            { source: 'admin' }
          );
        }
        console.log(`✅ ${person.name} 已改回 source=admin\n`);
      }
    }

    console.log('🎉 修正完成！');
    console.log('💡 新邏輯：');
    console.log('  - 有原始 QR 簽到的人 → source 根據內容是否改變而定');
    console.log('  - 純後台補登的人 → source 永遠是 admin\n');

  } catch (error) {
    console.error('❌ 錯誤:', error.message);
  }
}

main();
