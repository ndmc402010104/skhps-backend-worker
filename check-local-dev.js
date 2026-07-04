const fs = require('fs');
const vars = fs.readFileSync('.dev.vars', 'utf-8');

const supabaseUrl = vars.match(/SUPABASE_URL="([^"]+)"/)?.[1];
const token = vars.match(/SUPABASE_SERVICE_ROLE_KEY="([^"]+)"/)?.[1];

(async () => {
  try {
    console.log('🔍 查詢 local-dev 時間範圍...\n');
    
    const resMin = await fetch(`${supabaseUrl}/rest/v1/QrSigninRecord?select=signed_at,name,source&env=eq.local-dev&order=signed_at.asc&limit=5`, {
      headers: { 
        'Authorization': 'Bearer ' + token, 
        'apikey': token
      }
    });
    const minData = await resMin.json();
    
    const resMax = await fetch(`${supabaseUrl}/rest/v1/QrSigninRecord?select=signed_at,name,source&env=eq.local-dev&order=signed_at.desc&limit=5`, {
      headers: { 
        'Authorization': 'Bearer ' + token, 
        'apikey': token
      }
    });
    const maxData = await resMax.json();
    
    console.log('📊 local-dev 最早的5筆:');
    minData.forEach(r => console.log(`  ${r.signed_at} | ${r.source} | ${r.name}`));
    
    console.log('\n📊 local-dev 最晚的5筆:');
    maxData.forEach(r => console.log(`  ${r.signed_at} | ${r.source} | ${r.name}`));
    
    // 統計
    const resAll = await fetch(`${supabaseUrl}/rest/v1/QrSigninRecord?select=source&env=eq.local-dev`, {
      headers: { 
        'Authorization': 'Bearer ' + token, 
        'apikey': token,
        'Prefer': 'count=exact&limit=1000'
      }
    });
    const allData = await resAll.json();
    const stats = {};
    allData.forEach(r => {
      stats[r.source] = (stats[r.source] || 0) + 1;
    });
    
    console.log('\n📈 local-dev Source 統計:');
    Object.entries(stats).forEach(([s, c]) => {
      console.log(`  ${s}: ${c}`);
    });
    console.log(`\n總共: ${allData.length} 筆`);
  } catch (e) {
    console.error('❌ 錯誤:', e.message);
  }
})();
