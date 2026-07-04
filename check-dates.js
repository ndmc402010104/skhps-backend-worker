const fs = require('fs');
const vars = fs.readFileSync('.dev.vars', 'utf-8');
const token = vars.match(/SUPABASE_API_KEY=(.+)/)?.[1]?.trim();

(async () => {
  // 查询 local-dev 最新数据
  const localRes = await fetch('https://eipmmwsmcmnebdnzjgrv.supabase.co/rest/v1/QrSigninRecord?select=signed_at&env=eq.local-dev&order=signed_at.desc&limit=15', {
    headers: { Authorization: 'Bearer ' + token, apikey: token }
  });
  const localData = await localRes.json();
  console.log('📊 local-dev 最新15筆記錄:');
  localData.forEach(r => console.log('  ', r.signed_at));
  
  // 查询 prod 最新数据
  const prodRes = await fetch('https://eipmmwsmcmnebdnzjgrv.supabase.co/rest/v1/QrSigninRecord?select=signed_at&env=eq.prod&order=signed_at.desc&limit=15', {
    headers: { Authorization: 'Bearer ' + token, apikey: token }
  });
  const prodData = await prodRes.json();
  console.log('\n📊 prod 最新15筆記錄:');
  prodData.forEach(r => console.log('  ', r.signed_at));
})().catch(e => console.error(e.message));
