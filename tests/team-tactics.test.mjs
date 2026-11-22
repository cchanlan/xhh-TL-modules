import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
for(const id of ['abyss_team','hard_team']) {
 const base=path.join(root,'modules',id),res=path.join(base,'files','resources',id);
 const html=fs.readFileSync(path.join(res,id+'.html'),'utf8'),css=fs.readFileSync(path.join(res,id+'.css'),'utf8');
 test(id+' 正式包完整且与白名单源码逐字节一致',()=>{
  const meta=JSON.parse(fs.readFileSync(path.join(base,'module.json'),'utf8'));
  const module=JSON.parse(fs.readFileSync(path.join(root,'catalog.json'),'utf8')).modules.find(m=>m.id===id);
  const pack=fs.readFileSync(path.join(root,module.package));assert.equal(hash(pack),module.sha256);assert.equal(pack.length,module.bytes);
  const raw=JSON.parse(zlib.gunzipSync(pack));assert.equal(raw.id,id);assert.equal(raw.version,module.version);
  assert.deepEqual(raw.files.map(f=>f.path).sort(),meta.sourceFiles.slice().sort());
  for(const f of raw.files){const b=Buffer.from(f.content,'base64');assert.deepEqual(b,fs.readFileSync(path.join(base,'files',f.path)));const info=module.files.find(i=>i.path===f.path);assert.equal(hash(b),info.sha256);assert.equal(b.length,info.size);}
 });
 test(id+' 原有角色信息、身份、统计说明及分区全部保留',()=>{
  for(const field of ['qq','qqname','hasCk','version','generatedAt','lastUpdate','bgImage','team.count','a.name','a.face','a.star','a.level','a.cons','a.owned'])assert.ok(html.includes(field),field);
  for(const word of ['配队说明','提瓦特小助手','次出场','未持有','暂无','通用榜(未绑定CK)','已按本人练度排序','数据仅供参考','小火花体力小组件'])assert.ok(html.includes(word),word);
  if(id==='abyss_team'){for(const field of ['floors','fl.floor','team.up','team.down'])assert.ok(html.includes(field));assert.ok(!/第\s*11\s*层|实战记录|floor11/.test(html));}
  else{for(const field of ['sections','sec.label','sec.cls','team.roles','tips'])assert.ok(html.includes(field));}
 });
 test(id+' 保持验收圆角配色、背景边界及相对资源路径',()=>{
  const stage=css.match(/\.stage \{([^}]+)\}/)[1];assert.match(stage,/width: 1020rem/);assert.match(stage,/border-radius: 24rem/);assert.match(stage,/overflow: hidden/);assert.ok(!/padding:/.test(stage));
  assert.match(css,/--panel:\s*rgba\(235,241,247,\.92\)/);assert.match(css,/--panel:\s*rgba\(44, 59, 79, 0\.49\)/);
  assert.match(css,/\.tactics \{[^}]*border-radius: 18rem/);
  for(const cls of ['role','duo-row','single-row']){const rule=css.match(new RegExp('\\.'+cls+' \\{([^}]+)\\}'));if(rule)assert.ok(!/background:|border-radius:|box-shadow:/.test(rule[1]),cls);}
  assert.match(css,/url\('\.\.\/font\/NotoSansCJKsc-Regular\.ttf'\)/);assert.ok(html.includes('{{ppath}}'+id+'/'+id+'.css'));
  for(const text of [html,css])assert.ok(!/file:\/\/\/root\/|C:\\Users\\|\/root\/JiuLi|2606138772/.test(text),'no private paths or account');
 });
}
