import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {moduleFingerprint,nextModuleVersion} from '../scripts/version.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const hash=data=>crypto.createHash('sha256').update(data).digest('hex')
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xhh-build-'))
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
 fs.mkdirSync(path.join(dir,'scripts'))
 for(const file of ['build.mjs','version.mjs'])fs.copyFileSync(path.join(root,'scripts',file),path.join(dir,'scripts',file))
 for(const [id,dependencies] of [['shared',[]],['feature',['shared']],['other',[]]]){
  const base=path.join(dir,'modules',id);fs.mkdirSync(path.join(base,'files','utils'),{recursive:true})
  const meta={id,label:id,description:id,coreApi:2,dependencies,entries:[],internal:id==='shared',requiresMiao:false,sourceFiles:[`utils/${id}.js`],minCoreVersion:'2.1.0',minNodeVersion:'18.17.0'}
  fs.writeFileSync(path.join(base,'module.json'),JSON.stringify(meta));fs.writeFileSync(path.join(base,'files','utils',id+'.js'),'export const value=1\n')
 }
 const build=(...args)=>execFileSync(process.execPath,['scripts/build.mjs',...args],{cwd:dir,stdio:'pipe'})
 const catalog=()=>JSON.parse(fs.readFileSync(path.join(dir,'catalog.json')))
 const edit=(id,content)=>fs.writeFileSync(path.join(dir,'modules',id,'files','utils',id+'.js'),content)
 const get=id=>catalog().modules.find(m=>m.id===id)
 build();return {dir,build,catalog,edit,get}
}

test('相同内容重复构建保持目录、版本与包字节一致',t=>{
 const f=fixture(t),before=fs.readFileSync(path.join(f.dir,'catalog.json'))
 const packages=f.catalog().modules.map(m=>[m.package,hash(fs.readFileSync(path.join(f.dir,m.package)))])
 f.build();assert.deepEqual(fs.readFileSync(path.join(f.dir,'catalog.json')),before)
 for(const [file,digest] of packages)assert.equal(hash(fs.readFileSync(path.join(f.dir,file))),digest)
})
test('共享库变更递增依赖方版本，未涉及的模块不升版；重复构建稳定',t=>{
 const f=fixture(t),old=f.catalog();f.edit('shared','export const value=2\n');f.build()
 assert.equal(f.get('shared').version,'2.1.1');assert.equal(f.get('feature').version,'2.1.1');assert.equal(f.get('other').version,'2.1.0')
 assert.equal(f.get('feature').dependencyVersions.shared,'2.1.1');f.build();assert.equal(f.get('feature').version,'2.1.1')
 for(const m of old.modules)assert.equal(hash(fs.readFileSync(path.join(f.dir,m.package))),m.sha256)
})
test('源码回退仍递增发布，不复用旧数字版本',t=>{
 const f=fixture(t);f.edit('other','export const value=2\n');f.build();f.edit('other','export const value=1\n');f.build();assert.equal(f.get('other').version,'2.1.2')
})
test('显式补发只对指定模块及依赖方升一版',t=>{
 const f=fixture(t);f.build('--bump=shared,feature');assert.equal(f.get('shared').version,'2.1.1');assert.equal(f.get('feature').version,'2.1.1');assert.equal(f.get('other').version,'2.1.0');f.build();assert.equal(f.get('feature').version,'2.1.1')
})
test('旧哈希包保持可读，下次更新转换为数字版本且不覆盖旧包',t=>{
 const f=fixture(t),catalog=f.catalog(),old=catalog.modules.find(m=>m.id==='other')
 const oldVersion='2.1.0-'+moduleFingerprint(old).slice(0,12),raw=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(f.dir,old.package))))
 raw.version=oldVersion;const bytes=zlib.gzipSync(JSON.stringify(raw));Object.assign(old,{version:oldVersion,package:`packages/other/${oldVersion}.xhmp`,sha256:hash(bytes),bytes:bytes.length})
 fs.writeFileSync(path.join(f.dir,old.package),bytes);fs.writeFileSync(path.join(f.dir,'catalog.json'),JSON.stringify(catalog))
 f.build();assert.equal(f.get('other').version,oldVersion);f.edit('other','export const value=2\n');f.build();assert.equal(f.get('other').version,'2.1.1');assert.equal(hash(fs.readFileSync(path.join(f.dir,old.package))),old.sha256)
})
test('相同版本已存在但内容不同则拒绝，不覆盖历史包',t=>{
 const f=fixture(t),m=f.get('other'),file=path.join(f.dir,m.package),raw=JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));raw.files[0].content=Buffer.from('tampered').toString('base64')
 const modified=zlib.gzipSync(JSON.stringify(raw));fs.writeFileSync(file,modified);assert.throws(()=>f.build(),/不可变版本内容发生变化/);assert.deepEqual(fs.readFileSync(file),modified)
})
test('非法模块与参数拒绝执行，目录不变',t=>{
 const f=fixture(t),old=fs.readFileSync(path.join(f.dir,'catalog.json'))
 for(const arg of ['--bump=missing','--bump=','--unknown'])assert.throws(()=>f.build(arg))
 assert.deepEqual(fs.readFileSync(path.join(f.dir,'catalog.json')),old)
})
test('已有包但目录缺失或损坏时拒绝重置版本',t=>{
 const f=fixture(t),file=path.join(f.dir,'catalog.json');fs.unlinkSync(file);assert.throws(()=>f.build(),/缺少历史目录/)
 fs.writeFileSync(file,'{"schema":1}');assert.throws(()=>f.build(),/历史目录损坏/)
})
test('兼容要求、入口及宿主依赖变化纳入升版判断',t=>{
 const f=fixture(t),old=f.get('other')
 for(const change of [{coreApi:3},{minCoreVersion:'2.2.0'},{minNodeVersion:'20.0.0'},{requiresMiao:true},{entries:[{path:'utils/other.js',export:'value'}]}])assert.equal(nextModuleVersion(old,moduleFingerprint({...old,...change})),'2.1.1')
 assert.equal(nextModuleVersion({...old,version:'2.1.9'},moduleFingerprint({...old,requiresMiao:true})),'2.1.10')
 assert.throws(()=>nextModuleVersion({...old,version:'invalid'},moduleFingerprint(old)),/历史模块版本/)
})
