/** Node >=18；只打包清单白名单，不扫描运行时配置、数据或 node_modules。 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import {fileURLToPath} from 'node:url'
import {moduleFingerprint,nextModuleVersion} from './version.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const hash=b=>crypto.createHash('sha256').update(b).digest('hex')
// 分片命名/大小属于下载协议，与核心 utils/moduleStore.js 一致，不随构建机变化。
const PART_SIZE=512*1024
function writeParts(file,pack){
  if(pack.length<=PART_SIZE)return
  const directory=file+'.parts'
  fs.mkdirSync(directory,{recursive:true})
  if(!fs.lstatSync(directory).isDirectory()||fs.lstatSync(directory).isSymbolicLink())throw new Error('分片目录必须是普通目录')
  for(let offset=0,index=1;offset<pack.length;offset+=PART_SIZE,index++){
    const target=path.join(directory,String(index).padStart(4,'0')+'.part')
    const bytes=pack.subarray(offset,Math.min(offset+PART_SIZE,pack.length))
    if(fs.existsSync(target)){
      if(!fs.lstatSync(target).isFile())throw new Error('分片必须是普通文件')
      if(!fs.readFileSync(target).equals(bytes))throw new Error('不可变分片内容发生变化：'+target)
    }else fs.writeFileSync(target,bytes,{flag:'wx'})
  }
}
const args=process.argv.slice(2)
if(args.length>1||(args.length&&!/^--bump=[a-z][a-z0-9_]*(?:,[a-z][a-z0-9_]*)*$/.test(args[0])))throw new Error('用法：node scripts/build.mjs [--bump=模块id,模块id]')
const bumps=new Set(args.length?args[0].slice('--bump='.length).split(','):[])
const catalogPath=path.join(root,'catalog.json')
const previous=fs.existsSync(catalogPath)?JSON.parse(fs.readFileSync(catalogPath,'utf8')):null
if(previous&&(!Array.isArray(previous.modules)||previous.schema!==1))throw new Error('历史目录损坏，不能重置模块版本')
if(!previous&&fs.existsSync(path.join(root,'packages'))&&fs.readdirSync(path.join(root,'packages')).length)throw new Error('已有版本包但缺少历史目录，请先恢复 catalog.json')
const previousById=new Map((previous?.modules||[]).map(m=>[m.id,m]))
const catalog={schema:1,coreApi:2,minCoreVersion:'2.1.0',minNodeVersion:'18.17.0',modules:[]}
const owned=new Set()
const metadata=new Map(fs.readdirSync(path.join(root,'modules')).sort().map(id=>[id,JSON.parse(fs.readFileSync(path.join(root,'modules',id,'module.json'),'utf8'))]))
for(const id of bumps)if(!metadata.has(id))throw new Error('待升版模块不存在：'+id)
const order=[],visiting=new Set(),done=new Set()
function visit(id){if(done.has(id))return;if(visiting.has(id)||!metadata.has(id))throw new Error('依赖缺失或成环：'+id);visiting.add(id);for(const dep of metadata.get(id).dependencies)visit(dep);visiting.delete(id);done.add(id);order.push(id)}
for(const id of metadata.keys())visit(id)
for(const dir of order){
  const base=path.join(root,'modules',dir)
  const meta=JSON.parse(fs.readFileSync(path.join(base,'module.json'),'utf8'))
  const files=[],checks=[]
  for(const name of [...meta.sourceFiles].sort()){
    if(!/^(apps|utils|resources)\//.test(name)||name.includes('..')||name.includes(String.fromCharCode(92))) throw new Error('非法源文件路径')
    if(owned.has(name.toLowerCase())) throw new Error('文件归属重复：'+name)
    owned.add(name.toLowerCase())
    const file=path.join(base,'files',name)
    if(!fs.lstatSync(file).isFile()) throw new Error('只允许普通文件')
    const bytes=fs.readFileSync(file)
    checks.push({path:name,size:bytes.length,sha256:hash(bytes)})
    files.push({path:name,content:bytes.toString('base64')})
  }
  const dependencyVersions=Object.fromEntries(meta.dependencies.map(id=>[id,catalog.modules.find(m=>m.id===id).version]))
  const version=nextModuleVersion(previousById.get(meta.id),moduleFingerprint(meta,checks,dependencyVersions),bumps.has(meta.id))
  const raw=Buffer.from(JSON.stringify({schema:1,id:meta.id,version,files}))
  if(raw.length>96*1024*1024) throw new Error('模块包展开超限，请拆分资源包：'+meta.id)
  const relative=`packages/${meta.id}/${version}.xhmp`,out=path.join(root,relative)
  const exists=fs.existsSync(out)
  // gzip 头随操作系统变化，压缩流也可能随 zlib 版本变化；已发布包须逐字节保留。
  const pack=exists?fs.readFileSync(out):zlib.gzipSync(raw,{level:9})
  if(exists&&!zlib.gunzipSync(pack,{maxOutputLength:96*1024*1024}).equals(raw)) throw new Error('不可变版本内容发生变化')
  if(pack.length>64*1024*1024) throw new Error('模块包超限：'+meta.id)
  if(!exists){
    fs.mkdirSync(path.dirname(out),{recursive:true})
    fs.writeFileSync(out,pack)
  }
  writeParts(out,pack)
  const {sourceFiles,...published}=meta
  catalog.modules.push({...published,dependencyVersions,version,package:relative,sha256:hash(pack),bytes:pack.length,files:checks})
}
// 历史整包继续保留并补齐分片，旧缓存目录也能在 Gitee 安装/恢复。
for(const id of fs.readdirSync(path.join(root,'packages'))){
  const directory=path.join(root,'packages',id)
  if(!fs.lstatSync(directory).isDirectory())continue
  for(const name of fs.readdirSync(directory))if(name.endsWith('.xhmp')){
    const file=path.join(directory,name)
    if(!fs.lstatSync(file).isFile())throw new Error('模块包必须是普通文件')
    writeParts(file,fs.readFileSync(file))
  }
}
fs.writeFileSync(path.join(root,'catalog.json'),JSON.stringify(catalog,null,2)+'\n')
console.log(`Built ${catalog.modules.length} packages; ${owned.size} owned files`)
