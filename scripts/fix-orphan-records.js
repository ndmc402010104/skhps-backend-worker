#!/usr/bin/env node
/*
為孤兒記錄（沒有審計歷史）創建虛擬的初始審計快照
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
    console.log('\n🔧 為孤兒記錄創建虛擬初始審計快照\n');

    // 這三個人的記錄 ID
    const orphanRecords = [
      { name: '陳若蓉', empNo: 'R014514', recordId: 'd40efea8-f490-427a-a973-b652e9c5300d' },
      { name: '蔡可威', empNo: 'M013423', recordId: 'cab04fdf-6edf-44a4-bb76-01ec5401897c' },
      { name: '林享辰', empNo: 'M018094', recordId: 'be2fbd77-24c9-4a9d-bcba-642d97e04b6d' }
    ];

    // 先查一遍他們現在的完整數據
    for (const person of orphanRecords) {
      console.log(`⏳ 查詢 ${person.name} 的現在狀態...`);
      
      const record = await supabaseRest(
        URL,
        KEY,
        'GET',
        `/rest/v1/QrSigninRecord?id=eq.${person.recordId}&select=*`
      );

      if (Array.isArray(record) && record[0]) {
        const current = record[0];
        console.log(`   現在狀態: source="${current.source}" status="${current.status}"`);

        // 建立虛擬初始審計快照
        // 用當前的內容作為 "first state"
        const auditRecord = {
          record_id: person.recordId,
          meeting_id: current.meeting_id,
          action: 'init',  // 虛擬初始化
          actor_name: 'system',
          actor_employee_id: null,
          note: '虛擬初始審計快照（孤兒記錄）',
          after_data: {
            id: current.id,
            name: current.name,
            employee_id: current.employee_id,
            role: current.role,
            signed_at: current.signed_at,
            status: current.status,
            source: current.source,
            resultId: current.id
          },
          metadata: { system: true, virtual: true },
          env: current.env,
          app_id: current.app_id
        };

        console.log(`   建立審計記錄...`);
        const audit = await supabaseRest(
          URL,
          KEY,
          'POST',
          `/rest/v1/QrSigninRecordAudit`,
          auditRecord
        );

        if (audit && !audit.error) {
          console.log(`✅ ${person.name} 已建立虛擬審計快照\n`);
        } else {
          console.log(`❌ ${person.name} 建立失敗: ${JSON.stringify(audit)}\n`);
        }
      }
    }

    console.log('🎉 完成！現在他們可以參與比對邏輯了');
    console.log('💡 如果編輯後內容不變，就會回到 source="qr"（或原始值）');

  } catch (error) {
    console.error('❌ 錯誤:', error.message);
  }
}

main();
