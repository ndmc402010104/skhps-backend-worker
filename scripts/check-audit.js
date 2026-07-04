#!/usr/bin/env node
/*
查審計記錄：這三個人的簽到是怎麼來的
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
    console.log('\n📜 查詢審計記錄：這三個人的簽到來源\n');

    // 先找到他們的 record_id
    const recordIds = await supabaseRest(
      URL,
      KEY,
      'GET',
      `/rest/v1/QrSigninRecord?env=eq.local-dev&employee_id=in.("R014514","M013423","M018094")&select=id,name,employee_id`
    );

    if (Array.isArray(recordIds) && recordIds.length > 0) {
      console.log('找到的記錄ID：');
      recordIds.forEach(r => console.log(`  ${r.name} (${r.employee_id}) -> ID: ${r.id}`));

      for (const rec of recordIds) {
        console.log(`\n📋 ${rec.name} (${rec.employee_id}) 的審計記錄：`);
        const audits = await supabaseRest(
          URL,
          KEY,
          'GET',
          `/rest/v1/QrSigninRecordAudit?record_id=eq.${rec.id}&order=created_at.asc&select=action,actor_name,created_at,before_data,after_data`
        );

        if (Array.isArray(audits)) {
          console.log(`   共 ${audits.length} 筆審計紀錄`);
          audits.forEach((a, i) => {
            console.log(`   [${i+1}] action="${a.action}" actor="${a.actor_name}" time="${a.created_at}"`);
          });
        }
      }
    }

  } catch (error) {
    console.error('❌ 錯誤:', error.message);
  }
}

main();
