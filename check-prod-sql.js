const fs = require('fs');
const vars = fs.readFileSync('.dev.vars', 'utf-8');
const token = vars.match(/SUPABASE_API_KEY=(.+)/)?.[1]?.trim();
const url = 'https://eipmmwsmcmnebdnzjgrv.supabase.co';

(async () => {
  try {
    // 查询 prod 数据的日期分布
    console.log('🔍 查询 prod 中的数据...\n');
    
    const res = await fetch(`${url}/rest/v1/QrSigninRecord?select=signed_at,id,name,source&env=eq.prod&order=signed_at.desc&limit=30`, {
      headers: { 
        'Authorization': 'Bearer ' + token, 
        'apikey': token,
        'Content-Type': 'application/json'
      }
    });
    
    if (!res.ok) {
      console.log('❌ HTTP错误:', res.status, res.statusText);
      const text = await res.text();
      console.log('响应:', text);
      return;
    }
    
    const data = await res.json();
    console.log(`✅ 找到 ${data.length} 筆 prod 資料\n`);
    
    if (data.length > 0) {
      console.log('最新的30筆記錄:');
      data.slice(0, 30).forEach(r => {
        console.log(`  ${r.signed_at} | ${r.source} | ${r.name}`);
      });
      
      // 统计日期范围
      const dates = data.map(r => r.signed_at.split('T')[0]).sort();
      console.log(`\n📊 日期範圍: ${dates[dates.length-1]} 到 ${dates[0]}`);
    }
  } catch (e) {
    console.error('❌ 错误:', e.message);
  }
})();
