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

(async () => {
  const vars = loadDevVars();
  const URL = vars.SUPABASE_URL;
  const KEY = vars.SUPABASE_SERVICE_ROLE_KEY;

  try {
    console.log('\n🔍 檢查 local-dev 會議...\n');

    const res = await supabaseRest(
      URL,
      KEY,
      'GET',
      '/rest/v1/QrSigninMeeting?env=eq.local-dev&order=created_at.desc&limit=10'
    );

    if (Array.isArray(res.data) && res.data.length > 0) {
      console.log(`✅ 找到 ${res.data.length} 場會議\n`);
      res.data.forEach(m => {
        console.log(`  ${m.starts_at} - ${m.ends_at} | ${m.title}`);
      });
    } else {
      console.log('❌ local-dev 沒有會議！\n');
      
      // 檢查 prod 有多少會議
      const prodRes = await supabaseRest(
        URL,
        KEY,
        'GET',
        '/rest/v1/QrSigninMeeting?env=eq.prod&select=count=count()'
      );
      
      if (Array.isArray(prodRes.data)) {
        console.log(`prod 有 ${prodRes.data[0].count} 場會議`);
      }
    }
  } catch (e) {
    console.error('❌ 錯誤:', e.message);
  }
})();
