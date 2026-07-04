#!/usr/bin/env node
/*
測試：編輯陳若蓉，改一個欄位，看後端邏輯如何反應
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

function callWorkerApi(payload) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'skhps-backend.ndmc402010104.workers.dev',
      path: '/api/action',
      method: 'POST',
      headers: {
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
    req.write(JSON.stringify(payload));
    req.end();
  });
}

async function main() {
  const vars = loadDevVars();
  
  try {
    console.log('\n🧪 測試：編輯陳若蓉\n');

    // 編輯陳若蓉：改職級為 R4（原本是 NP）
    const payload = {
      action: 'updateQrSigninRecord',
      env: 'local-dev',
      recordId: 'd40efea8-f490-427a-a973-b652e9c5300d',
      meetingId: '',
      name: '陳若蓉',
      employeeId: 'R014514',
      role: 'R4',  // 改成 R4
      signedAt: '2026-06-22T07:34:00',
      status: 'signed',
      reason: '',
      // 不發送 source
    };

    console.log('📤 發送編輯請求...');
    const response = await callWorkerApi(payload);

    console.log('\n📥 後端回應：');
    if (response && response.data) {
      console.log(`   source: "${response.data.sourceRaw || response.data.source}"`);
      console.log(`   name: "${response.data.name}"`);
      console.log(`   role: "${response.data.role}"`);
      console.log(`   status: "${response.data.status}"`);
      console.log('\n✅ 邏輯測試完成');
    } else {
      console.log('❌ 收不到回應:', response);
    }

  } catch (error) {
    console.error('❌ 錯誤:', error.message);
  }
}

main();
