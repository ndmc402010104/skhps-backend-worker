const fs = require('fs');
const vars = fs.readFileSync('.dev.vars', 'utf-8');

const supabaseUrl = vars.match(/SUPABASE_URL="([^"]+)"/)?.[1];
const token = vars.match(/SUPABASE_SERVICE_ROLE_KEY="([^"]+)"/)?.[1];

(async () => {
  try {
    // 統計 prod 中所有的數據
    console.log('📊 統計 prod 全部記錄...\n');
    
    const res = await fetch(`${supabaseUrl}/rest/v1/QrSigninRecord?select=id&env=eq.prod&limit=1`, {
      headers: { 
        'Authorization': 'Bearer ' + token, 
        'apikey': token,
        'Prefer': 'count=exact'
      }
    });
    
    const count = res.headers.get('content-range');
    console.log('📡 Content-Range:', count);
    
    // 查詢時間範圍
    console.log('\n⏱️  查詢時間範圍...');
    
    const resMin = await fetch(`${supabaseUrl}/rest/v1/QrSigninRecord?select=signed_at&env=eq.prod&order=signed_at.asc&limit=5`, {
      headers: { 
        'Authorization': 'Bearer ' + token, 
        'apikey': token
      }
    });
    const minData = await resMin.json();
    
    const resMax = await fetch(`${supabaseUrl}/rest/v1/QrSigninRecord?select=signed_at&env=eq.prod&order=signed_at.desc&limit=5`, {
      headers: { 
        'Authorization': 'Bearer ' + token, 
        'apikey': token
      }
    });
    const maxData = await resMax.json();
    
    console.log('\n最早的5筆:');
    minData.forEach(r => console.log('  ', r.signed_at));
    
    console.log('\n最晚的5筆:');
    maxData.forEach(r => console.log('  ', r.signed_at));
    
    // 統計 source 分布
    console.log('\n📈 統計 source 分布...');
    const resStats = await fetch(`${supabaseUrl}/rest/v1/rpc/count_by_source_prod`, {
      method: 'POST',
      headers: { 
        'Authorization': 'Bearer ' + token, 
        'apikey': token,
        'Content-Type': 'application/json'
      }
    });
    
    if (resStats.ok) {
      const stats = await resStats.json();
      console.log('結果:', stats);
    } else {
      console.log('⚠️  RPC 不存在，用另一種方式查詢...');
      
      // 直接查詢 prod local-dev 所有記錄的 source
      const resAll = await fetch(`${supabaseUrl}/rest/v1/QrSigninRecord?select=source&env=eq.prod`, {
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
      console.log('Source 統計:');
      Object.entries(stats).forEach(([s, c]) => {
        console.log(`  ${s}: ${c}`);
      });
    }
  } catch (e) {
    console.error('❌ 錯誤:', e.message);
  }
})();
