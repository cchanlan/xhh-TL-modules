/** Node >=18；只打包清单白名单，不扫描运行时配置、数据或 node_modules。 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import {fileURLToPath} from 'node:url'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const hash=b=>crypto.createHash('sha256').update(b).digest('hex')
const catalog={schema:1,coreApi:2,minCoreVersion:'2.1.0',minNodeVersion:'18.17.0',modules:[]}
const owned=new Set()
const metadata=new Map(fs.readdirSync(path.join(root,'modules')).sort().map(id=>[id,JSON.parse(fs.readFileSync(path.join(root,'modules',id,'module.json'),'utf8'))]))
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
  const version='2.1.0-'+hash(JSON.stringify({checks,dependencyVersions,entries:meta.entries,coreApi:meta.coreApi,minCoreVersion:meta.minCoreVersion,minNodeVersion:meta.minNodeVersion,requiresMiao:meta.requiresMiao})).slice(0,12)
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
  const {sourceFiles,...published}=meta
  catalog.modules.push({...published,dependencyVersions,version,package:relative,sha256:hash(pack),bytes:pack.length,files:checks})
}
fs.writeFileSync(path.join(root,'catalog.json'),JSON.stringify(catalog,null,2)+'\n')
console.log(`Built ${catalog.modules.length} packages; ${owned.size} owned files`)
