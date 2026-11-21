/** 版本跟随内容与精确依赖变化；旧哈希版本保留，下一次发布转为数字补丁版本。 */
import crypto from 'node:crypto'

export function moduleFingerprint(meta,checks=meta.files,dependencyVersions=meta.dependencyVersions){
  return crypto.createHash('sha256').update(JSON.stringify({checks,dependencyVersions,entries:meta.entries,coreApi:meta.coreApi,minCoreVersion:meta.minCoreVersion,minNodeVersion:meta.minNodeVersion,requiresMiao:meta.requiresMiao})).digest('hex')
}

export function nextModuleVersion(previous,fingerprint,forceBump=false){
  if(!previous)return '2.1.0'
  const match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-f0-9]{12})?$/.exec(previous.version)
  if(!match)throw new Error('不支持的历史模块版本：'+previous.version)
  const [major,minor,patch]=match.slice(1).map(Number)
  if(![major,minor,patch].every(Number.isSafeInteger)||!Number.isSafeInteger(patch+1))throw new Error('模块版本超出范围')
  if(!forceBump&&moduleFingerprint(previous)===fingerprint)return previous.version
  return `${major}.${minor}.${patch+1}`
}
