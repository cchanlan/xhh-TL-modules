import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const resources=path.join(root,'modules','role_combat','files','resources','role_combat');
const html=fs.readFileSync(path.join(resources,'role_combat.html'),'utf8');
const css=fs.readFileSync(path.join(resources,'role_combat.css'),'utf8');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
test('幻想角色正式包与白名单源码字节和哈希一致',()=>{
 const catalog=JSON.parse(fs.readFileSync(path.join(root,'catalog.json'),'utf8'));
 const m=catalog.modules.find(m=>m.id==='role_combat');
 const bytes=fs.readFileSync(path.join(root,m.package));
 assert.equal(hash(bytes),m.sha256);assert.equal(bytes.length,m.bytes);
 const raw=JSON.parse(zlib.gunzipSync(bytes));
 assert.equal(raw.id,m.id);assert.equal(raw.version,m.version);
 const meta=JSON.parse(fs.readFileSync(path.join(root,'modules','role_combat','module.json'),'utf8'));
 assert.deepEqual(raw.files.map(f=>f.path).sort(),meta.sourceFiles.slice().sort());
 for(const f of raw.files){
  const content=Buffer.from(f.content,'base64');
  assert.deepEqual(content,fs.readFileSync(path.join(root,'modules','role_combat','files',f.path)));
  const info=m.files.find(item=>item.path===f.path);assert.equal(hash(content),info.sha256);assert.equal(content.length,info.size);
 }
});
test('手册模板保留所有原业务信息及异常提示入口',()=>{
 for(const field of ['month','queryUser','queryUid','elements','opening','invite','available','monsters','m.stage','m.names','c.name','c.face','c.elemName','c.star','version','generatedAt','ckMissing','filterApplied','requestedMonth','fallback']) assert.ok(html.includes(field),field);
 for(const word of ['幻想真境剧诗','开幕角色','特邀角色','关键关卡怪物','拥有的可用角色','暂无符合条件的角色','#扫码登录','Alioth.wiki','小火花']) assert.ok(html.includes(word),word);
 assert.ok(!html.includes('chapter-number'));
});
test('元素名册稳定分组且未知元素不会被静默丢弃',()=>{
 assert.match(html,/rosterOrder\s*=\s*elements\.concat/);
 assert.match(html,/all\.indexOf\(el\) === i/);
 assert.match(html,/concat\(\['other'\]\)/);
 assert.match(html,/el === 'other' \? !elementNames\[c\.elemClass\] : c\.elemClass === el/);
 assert.match(html,/each members c/);
});
test('验收配色与圆角背景边界保持，条目不恢复小卡框',()=>{
 assert.match(css,/--roster-tone:\s*rgba\(220, 229, 240, 0\.45\)/);
 assert.match(css,/--roster-tone:\s*rgba\(40, 51, 72, 0\.49\)/);
 for(const name of ['cast','encounter','roster']) assert.match(css,new RegExp('\\.'+name+'-chapter \\{ background: var\\(--roster-tone\\); \\}'));
 const stage=css.match(/\.stage \{([^}]+)\}/)[1];
 assert.match(stage,/width: 860rem/);assert.match(stage,/padding: 0/);assert.match(stage,/border-radius: 24rem/);assert.match(stage,/overflow: hidden/);
 assert.match(css,/\.chapter \{[^}]*border-radius: 18rem/);
 for(const name of ['cast-member','encounter','roster-member']) {
  const rule=css.match(new RegExp('\\.'+name+' \\{([^}]+)\\}'))[1];
  assert.ok(!/background:|border-radius:|box-shadow:/.test(rule),name);
 }
});
test('分发模板使用相对资源路径，不泄露本机和服务器私有路径',()=>{
 assert.match(html,/\{\{ppath\}\}role_combat\/role_combat\.css/);
 assert.match(css,/url\('\.\.\/font\/NotoSansCJKsc-Regular\.ttf'\)/);
 for(const text of [html,css]) assert.ok(!/file:\/\/\/root\/|C:\\Users\\|\/root\/JiuLi|102515702/.test(text));
});
