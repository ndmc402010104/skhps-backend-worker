const fs = require('fs');
const vars = fs.readFileSync('.dev.vars', 'utf-8');

const supabaseUrl = vars.match(/SUPABASE_URL="([^"]+)"/)?.[1];
const token = vars.match(/SUPABASE_SERVICE_ROLE_KEY="([^"]+)"/)?.[1];

console.log('🔧 配置:');
console.log('  URL:', supabaseUrl);
console.log('  Token长度:', token?.length);

(async () => {
  try {
    console.log('\n🔍 查询 prod 中的最新30筆記錄...\n');
    
    const res = await fetch(`${supabaseUrl}/rest/v1/QrSigninRecord?select=signed_at,id,name,source&env=eq.prod&order=signed_at.desc&limit=30`, {
      headers: { 
        'Authorization': 'Bearer ' + token, 
        'apikey': token
      }
    });
    
    console.log('📡 HTTP状态:', res.status);
    
    if (!res.ok) {
      const text = await res.text();
      console.log('❌ 响应:', text);
      return;
    }
    
    const data = await res.json();
    console.log(`✅ 找到 ${data.length} 筆記錄\n`);
    
    if (data.length > 0) {
      data.slice(0, 30).forEach(r => {
        console.log(`  ${r.signed_at} | ${r.source} | ${r.name}`);
      });
      
      const dates = data.map(r => r.signed_at.split('T')[0]).sort().reverse();
      console.log(`\n📊 日期範圍: ${dates[0]} 到 ${dates[dates.length-1]}`);
    } else {
      console.log('⚠️  没有找到数据');
    }
  } catch (e) {
    console.error('❌ 错误:', e.message);
  }
})();
