import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const src=id=>fs.readFileSync(path.join(root,'modules',id,'files','apps',id==='role_combat'?'miniRoleCombat.js':id),'utf8');
const mini=src('role_combat');
const moment=()=>({format:()=> '11-22 08:00',month:()=>10});
function helpers(){const c={Character:{get:()=>null},faceUrl:v=>v,moment};vm.createContext(c);vm.runInContext(mini.slice(mini.indexOf('function intToRoman'),mini.indexOf('export class miniRoleCombat')),c);return c;}
const round={round_id:3,is_get_medal:true,avatars:[{avatar_id:1,name:'甲',avatar_type:1,level:90,rarity:5}],enemies:[{name:'怪物',level:100,icon:'https://example.test/enemy.png'}]};
const role={data:[{has_detail_data:true,schedule:{month:11},stat:{difficulty_id:5,coin_num:100,get_medal_round_list:[1,1]},detail:{rounds_data:[round],fight_statisic:{total_use_time:20}}},{has_detail_data:true,schedule:{month:10},stat:{},detail:{rounds_data:[round]}}]};
const gear={id:1,name:'甲',cons:0,level:90,weapon:{id:7,name:'武器',affix:1,img:'weapon.png'},artisSet:{name:'套装4',imgs:['artifact.png']},talent:{a:{level:1},e:{level:10},q:{level:8}}};
async function run(response,{cache={1:gear},msg='#小幻想',target='',detailResponse,throwRole=false}={}){
 let captured;const replies=[];
 const c={moment,lodash:{uniq:a=>[...new Set(a)]},YAML:{},Character:{get:()=>null},faceUrl:v=>v,plugin:class{},Bot:{uin:'bot'},logger:{debug(){},error(){}},config:()=>({}),pluginDir:'/plugin',pickGsBgImage:()=>'',guardModule:()=>{},prepareMysContext:async()=>{},replyProgress:async(e,s)=>e.reply(s),resolveTargetQq:()=>target,resolveDisplayName:async(e,q)=>q==='target'?'目标昵称':'触发者昵称',renderTpl:async(e,{data})=>(captured=data),MysApi:{init:async()=>({uid:target?'200000002':'100000001',checkCk:async()=>true,getRoleCombat:async()=>{if(throwRole)throw Error('fail');return role},getCharacter:async()=>{if(response instanceof Error)throw response;return response},getCharacterDetail:async()=>detailResponse})},Player:{create:()=>({getAvatarData:()=>cache})}};
 vm.createContext(c);vm.runInContext(mini.replace(/^import .*$/gm,'').replace('export class miniRoleCombat','class miniRoleCombat')+'\nglobalThis.Mini=miniRoleCombat;',c);
 const e={user_id:'self',self_id:'bot',sender:{nickname:'触发者昵称'},msg,original_msg:msg,message:[],reply:async s=>replies.push(s)};
 await new c.Mini().mini(e);return {data:captured,replies,e};
}
test('新版 list/base、旧版 avatars、带 data 包装均归一化',()=>{const h=helpers();for(const response of [{avatars:[{id:1}]},{list:[{base:{id:1,name:'甲'},weapon:{name:'武器'}}]},{retcode:0,data:{list:[{id:1}]}}])assert.equal(h.normalizeCharacterResponse(response)[0].id,1);});
test('验证码和空资料不当成角色列表',()=>{const h=helpers();for(const r of [false,null,{retcode:1034,list:[{id:1}]},{retcode:-1,data:{}},{}])assert.equal(h.normalizeCharacterResponse(r).length,0);});
test('资料更新不会删掉列表以外的缓存角色',()=>{const h=helpers(),map={2:{id:2,name:'乙'},1:gear};h.mergeCharacterData(map,[{id:1,name:'甲',level:90}],false);assert.equal(map[2].name,'乙');assert.equal(map[1].weapon.name,'武器');assert.equal(map[1].talent.q.level,8);});
test('新版装备字段和套装件数完整保留',()=>{const h=helpers(),map={};h.mergeCharacterData(map,[{id:1,element:'Electro',actived_constellation_num:0,weapon:{id:7,name:'武器',icon:'w.png',affix_level:5},relics:[{set:{name:'套装'},icon:'a.png'},{set:{name:'套装'},icon:'b.png'}]}],true);assert.equal(map[1].weapon.affix,5);assert.equal(map[1].artisSet.name,'套装×2');assert.equal(map[1].cons,0);assert.equal(map[1].elem,'electro');});
for(const [label,response] of [['验证码1034',{retcode:1034}],['新版空list',{list:[]}],['角色接口异常',new Error('network')]])test(label+'仍用真实战报和缓存出图',async()=>{const r=await run(response);assert.ok(r.data);assert.equal(r.data.stageCount,1);assert.equal(r.data.stages[0].avatars[0].weapon.name,'武器');assert.equal(r.data.detailUnavailable,true);assert.ok(!r.replies.some(s=>s.includes('角色信息获取失败')));});
test('无缓存时不伪造零命或装备天赋',async()=>{const {data}=await run({retcode:1034},{cache:{}});const a=data.stages[0].avatars[0];assert.equal(a.cons,null);assert.equal(a.weapon,null);assert.equal(a.artis,null);assert.equal(a.talent.e,'');assert.equal(a.level,90);});
test('少于四个角色的新版list仍然可用',async()=>{const {data}=await run({list:[{id:1,name:'甲',level:90}]},{detailResponse:{list:[{base:{id:1},weapon:{id:7,name:'新武器',icon:'new.png'}}]}});assert.equal(data.stages[0].avatars[0].weapon.name,'新武器');assert.equal(data.detailUnavailable,false);});
test('旧版完整角色资料仍显示装备和天赋',async()=>{const {data}=await run({avatars:[{id:1,name:'甲',weapon:{id:7,name:'旧武器',icon:'old.png',affix_level:2}}]});assert.equal(data.stages[0].avatars[0].weapon.affix,2);assert.equal(data.stages[0].avatars[0].talent.q,8);});
test('@目标显示其昵称和UID而不是发送者',async()=>{const {data,e}=await run({retcode:1034},{target:'target'});assert.equal(e.at,'target');assert.equal(data.qq,'target');assert.equal(data.qqname,'目标昵称');assert.equal(data.uid,'200000002');});
test('上期指令选上期数据',async()=>{const {data}=await run({retcode:1034},{msg:'#上期小幻想'});assert.equal(data.month,10);assert.equal(data.periodText,'上期');});
test('战报本身失败仍正确报错，不用缓存伪造战报',async()=>{const {data,replies}=await run(false,{throwRole:true});assert.equal(data,undefined);assert.ok(replies.some(s=>s.includes('战报获取失败')));});
test('试用助演不借用同ID的自有装备天赋',()=>{const h=helpers();for(const type of [2,3]){const a=h.resolveAvatarCard({avatar_id:1,name:'甲',avatar_type:type,level:80},{1:gear});assert.equal(a.weapon,null);assert.equal(a.talent.q,'');assert.equal(a.cons,null);assert.ok(a.typeLabel);}});
test('关键幕和双圣牌排序不变',()=>{const h=helpers();const rounds=[{round_id:1},{round_id:10},{round_id:3},{round_id:6},{round_id:8},{is_tarot:true,tarot_serial_no:2},{is_tarot:true,tarot_serial_no:1}];assert.equal(h.buildKeyStages({detail:{rounds_data:rounds}},{}).map(s=>s.title).join('|'),'第 3 幕|第 6 幕|第 8 幕|第 10 幕|圣牌挑战 I|圣牌挑战 II');});
const shared=fs.readFileSync(path.join(root,'modules/shared_gs/files/utils/gsHelper.js'),'utf8');
function sharedContext({uid='100000001',mys=false,target=''}={}){const c={Bot:{uin:'bot'},prepareMysContext:async()=>{},createUser:async qq=>({getUid:()=>qq==='target'?'200000002':uid}),MysApi:{init:async()=>mys},Player:{create:()=>({refresh:async()=>{},getAvatarData:()=>({})})},logger:{debug(){}}};vm.createContext(c);vm.runInContext(shared.slice(shared.indexOf('export function resolveTargetQq')).replace(/export /g,''),c);return c;}
test('无CK仍显示已绑定的本人UID',async()=>{const c=sharedContext();const d=await c.loadAvatarData({user_id:'self'});assert.equal(d.uid,'100000001');assert.equal(d.hasCk,false);});
test('无CK的@目标UID不串到本人',async()=>{const c=sharedContext();const d=await c.loadAvatarData({user_id:'self',at:'target'});assert.equal(d.uid,'200000002');});
test('Mys实际查询UID优先于旧绑定',async()=>{const c=sharedContext({mys:{uid:'300000003',checkCk:async()=>false}});const d=await c.loadAvatarData({user_id:'self'});assert.equal(d.uid,'300000003');});
test('没有绑定不展示旧UID',async()=>{const c=sharedContext({uid:''});const d=await c.loadAvatarData({user_id:'self'});assert.equal(d.uid,'');});
test('长群名片完整显示，以消息本人昵称为准',async()=>{const c=sharedContext(),name='这是长度超过二十个字的完整昵称名字不能被截短或改成当前用户';assert.equal(await c.resolveDisplayName({user_id:'self',sender:{card:name,nickname:'别名'}},'self'),name);});
test('忽略@机器人本人',()=>{const c=sharedContext();assert.equal(c.resolveTargetQq({self_id:'bot',message:[{type:'at',qq:'bot'}]}),'');});
test('五张图均有头像昵称UID，所有既有字段完整保留',()=>{
 for(const mod of ['abyss_team','hard_team','hold_rate','role_combat']){const html=fs.readFileSync(path.join(root,'modules',mod,'files','resources',mod,mod+'.html'),'utf8');for(const text of ['UID','q1.qlogo.cn','nk={{qq}}'])assert.ok(html.includes(text),mod+' '+text);assert.ok(html.includes(mod==='role_combat'?'{{queryUser}}':'{{qqname}}'));}
 const html=fs.readFileSync(path.join(root,'modules/role_combat/files/resources/role_combat/mini_role_combat.html'),'utf8');
 for(const field of ['qqname','uid','periodText','month','difficulty','totalTime','coin','medalTotal','stageCount','generatedAt','s.title','s.is_get_medal','s.finish_time','a.face','a.name','a.cons','a.level','a.star','a.typeLabel','a.talent.a','a.talent.e','a.talent.q','a.weapon.img','a.weapon.affix','a.artis.imgs','en.name','en.level','en.icon'])assert.ok(html.includes(field),field);
 assert.ok(!/ellipsis|white-space:\s*nowrap|linear-gradient|box-shadow/.test(fs.readFileSync(path.join(root,'modules/role_combat/files/resources/role_combat/mini_role_combat.css'),'utf8')));
});
test('天赋兼容数值、字符串与level/original对象，不补猜测值',()=>{const h=helpers();for(const [input,expected] of [[8,8],['10',10],[{level:11},11],[{original:9},9],[null,''],[false,'']])assert.equal(h.readTalent(input),expected);});
test('未知套装字段不清空已有套装缓存',()=>{const h=helpers(),map={1:gear};h.mergeCharacterData(map,[{id:1,relics:[{name:'仅有单件名',icon:'one.png'}]}],true);assert.equal(map[1].artisSet.name,'套装4');});
