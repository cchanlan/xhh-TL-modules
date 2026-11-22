import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=path.join(root,'modules','hold_rate');
const res=path.join(base,'files','resources','hold_rate');
const html=fs.readFileSync(path.join(res,'hold_rate.html'),'utf8');
const css=fs.readFileSync(path.join(res,'hold_rate.css'),'utf8');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
test('持有率正式包与清单及源码逐字节一致',()=>{
 const catalog=JSON.parse(fs.readFileSync(path.join(root,'catalog.json'),'utf8'));
 const m=catalog.modules.find(m=>m.id==='hold_rate'),meta=JSON.parse(fs.readFileSync(path.join(base,'module.json'),'utf8'));
 const bytes=fs.readFileSync(path.join(root,m.package));assert.equal(hash(bytes),m.sha256);assert.equal(bytes.length,m.bytes);
 const raw=JSON.parse(zlib.gunzipSync(bytes));assert.equal(raw.id,m.id);assert.equal(raw.version,m.version);assert.deepEqual(raw.files.map(f=>f.path).sort(),meta.sourceFiles.slice().sort());
 for(const f of raw.files){const b=Buffer.from(f.content,'base64');assert.deepEqual(b,fs.readFileSync(path.join(base,'files',f.path)));const info=m.files.find(i=>i.path===f.path);assert.equal(hash(b),info.sha256);assert.equal(b.length,info.size);}
});
test('持有率原信息和样本统计口径完整保留',()=>{
 for(const field of ['qq','qqname','hasCk','ownedCount','total','version','generatedAt','lastUpdate','bgImage','groups','g.star','g.count','c.name','c.face','c.star','c.rateText','c.owned'])assert.ok(html.includes(field),field);
 for(const word of ['角色持有率','深渊参与者','参与本期深渊统计玩家','提瓦特小助手','从高到低排序','已持有','暂未持有','通用榜(未绑定CK)','绑定 CK 后可标记','数据仅供参考','小火花体力小组件'])assert.ok(html.includes(word),word);
 assert.match(html,/each groups g/);assert.match(html,/each g.chars c/);
});
test('无CK不标未持有，绘制条不更改原百分比且标尺一致',()=>{
 assert.ok(html.includes("hasCk ? (c.owned ? 'owned' : 'unowned') : 'unknown'"));
 assert.match(html,/\{\{if hasCk\}\}\{\{if !c\.owned\}\}<span class="ownership-status">未持有/);
 assert.match(html,/class="hold-rate">\{\{c\.rateText\}\}/);
 assert.ok(html.includes('c.rate < 0 ? 0 : c.rate > 100 ? 100 : c.rate'));
 assert.match(css,/\.entry-detail \{[^}]*grid-template-columns: minmax\(0, 1fr\) 30rem/);
 assert.ok(!/\.unowned\s*\{[^}]*opacity:/.test(css),'do not fade all data together');
});
test('验收背景边界与圆角配色保持，角色无独立卡片',()=>{
 const stage=css.match(/\.stage \{([^}]+)\}/)[1];assert.match(stage,/width: 1020rem/);assert.match(stage,/border-radius: 24rem/);assert.match(stage,/overflow: hidden/);assert.ok(!/padding:/.test(stage));
 assert.match(css,/--panel:\s*rgba\(235,241,247,\.92\)/);assert.match(css,/--panel:\s*rgba\(44, 59, 79, 0\.49\)/);assert.match(css,/\.catalog-group \{[^}]*border-radius: 18rem/);
 const row=css.match(/\.ownership-row \{([^}]+)\}/)[1];assert.ok(!/background:|border-radius:|box-shadow:/.test(row));
});
test('持有率模板相对资源路径可分发，不含私有账号或绝对路径',()=>{
 assert.ok(html.includes('{{ppath}}hold_rate/hold_rate.css'));assert.match(css,/url\('\.\.\/font\/NotoSansCJKsc-Regular\.ttf'\)/);
 for(const text of [html,css])assert.ok(!/file:\/\/\/root\/|C:\\Users\\|\/root\/JiuLi|2606138772|102515702/.test(text));
});
