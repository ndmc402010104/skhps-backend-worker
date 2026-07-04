#!/usr/bin/env node
/*
直接檢查陳若臻、蔡可威、林享辰的資料庫狀態
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

function supabaseRest(url, key, method, path) {
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
    req.end();
  });
}

async function main() {
  const vars = loadDevVars();
  const URL = vars.SUPABASE_URL;
  const KEY = vars.SUPABASE_SERVICE_ROLE_KEY;

  try {
    console.log('\n🔍 查詢陳若臻、蔡可威、林享辰的完整資料\n');

    const peopleToCheck = [
      { name: '陳若臻', empNo: 'R014514' },
      { name: '蔡可威', empNo: 'M013423' },
      { name: '林享辰', empNo: 'M018094' }
    ];

    for (const person of peopleToCheck) {
      const records = await supabaseRest(
        URL,
        KEY,
        'GET',
        `/rest/v1/QrSigninRecord?env=eq.local-dev&employee_id=eq.${person.empNo}&select=*`
      );

      console.log(`\n📋 ${person.name} (${person.empNo}):`);
      if (Array.isArray(records)) {
        console.log(`   共 ${records.length} 筆記錄`);
        records.forEach((r, i) => {
          console.log(`   [${i+1}] source="${r.source}" status="${r.status}" signed_at="${r.signed_at}"`);
        });
      }
    }

  } catch (error) {
    console.error('❌ 錯誤:', error.message);
  }
}

main();
