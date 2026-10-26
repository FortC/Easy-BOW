/** 官方 GitHub 发布：提交/标签核对 → 草稿 → 上传并校验 → 公开。
 * 凭证仅在内存中使用，不打印，不经下载代理。
 * node scripts/publish-release.mjs --version 4.7.0 --notes docs/release-notes-v4.7.0.md
 */
import { spawnSync } from 'node:child_process'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const arg = (key, fallback = '') => { const i = argv.indexOf(`--${key}`); return i < 0 ? fallback : argv[i + 1] }
const version = arg('version')
const notes = arg('notes')
const repo = process.env.GH_REPO || 'FortC/Easy-BOW'
const dir = arg('dir', 'dist')
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version || '') || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('版本号或仓库名无效')
if (!notes || !existsSync(notes)) throw new Error('缺少发布说明文件')
const tag = `v${version}`
const base = `https://api.github.com/repos/${repo}`
const git = (args, extra = {}) => spawnSync('git', args, { encoding: 'utf8', windowsHide: true, ...extra })
const head = git(['rev-parse', 'HEAD']).stdout.trim()
if (JSON.parse(readFileSync('package.json', 'utf8')).version !== version) throw new Error('package.json 版本与发布版本不一致')
if (git(['diff', '--quiet']).status !== 0 || git(['diff', '--cached', '--quiet']).status !== 0) throw new Error('存在尚未提交的修改，禁止发布来源不明确的安装包')
const tagged = git(['rev-parse', `${tag}^{commit}`])
if (tagged.status !== 0 || tagged.stdout.trim() !== head) throw new Error('发布标签必须存在且指向当前 HEAD')
const names = [`EasyBow-Setup-${version}.exe`, `EasyBow-Portable-${version}.exe`, `EasyBow-Setup-${version}.exe.blockmap`, 'latest.yml', `SHA256SUMS-${version}.txt`]
for (const name of names) if (!existsSync(join(dir, name)) || !statSync(join(dir, name)).size) throw new Error(`缺少产物: ${name}`)

async function getToken() {
  const candidates = [process.env.GH_TOKEN, process.env.GITHUB_TOKEN].filter(Boolean).map((s) => s.trim())
  const credential = git(['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } })
  const saved = credential.stdout?.match(/^password=(.+)$/m)?.[1]?.trim()
  if (saved) candidates.push(saved)
  for (const token of candidates) {
    const result = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'easybow-publish' }, signal: AbortSignal.timeout(15000) })
    if (result.ok) return token
  }
  throw new Error('GitHub 凭证不可用，请在本机重新登录；不要把密钥写入仓库')
}

async function hash(file) {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(file)) h.update(chunk)
  return h.digest('hex')
}

async function main() {
  const token = await getToken()
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'easybow-publish' }
  const api = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) })
    if (response.status === 404 && method === 'GET') return null
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`)
    return response.json()
  }
  const remoteTag = await api('GET', `/git/ref/tags/${tag}`)
  if (remoteTag?.object?.type !== 'commit' || remoteTag.object.sha !== head) throw new Error('远端标签没有指向当前提交，禁止发布错误版本')
  const local = await Promise.all(names.map(async (name) => ({ name, file: join(dir, name), size: statSync(join(dir, name)).size, sha256: await hash(join(dir, name)) })))
  let release = await api('GET', `/releases/tags/${tag}`)
  if (!release) release = await api('POST', '/releases', { tag_name: tag, target_commitish: head, name: `EasyBow ${tag}`, body: readFileSync(notes, 'utf8'), draft: true, prerelease: version.includes('-') })
  console.log(`Release 草稿就绪: ${tag} (${head.slice(0, 12)})`)
  for (const artifact of local) {
    const present = release.assets?.find((a) => a.name === artifact.name)
    if (present) {
      if (present.size !== artifact.size || (present.digest && present.digest !== `sha256:${artifact.sha256}`)) throw new Error(`远端已有不同内容附件: ${artifact.name}`)
      console.log(`已验证现有附件: ${artifact.name}`)
      continue
    }
    console.log(`上传 ${artifact.name} (${(artifact.size / 1048576).toFixed(1)} MiB)…`)
    const stream = (async function* () {
      let sent = 0
      let last = 0
      for await (const chunk of createReadStream(artifact.file)) {
        sent += chunk.length
        if (sent - last >= 100 * 1048576) { last = sent; console.log(`  ${artifact.name}: ${(sent / 1048576).toFixed(0)} MiB 已发送`) }
        yield chunk
      }
    })()
    const response = await fetch(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(artifact.name)}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(artifact.size) }, body: stream, duplex: 'half'
    })
    if (!response.ok) throw new Error(`附件上传失败: ${artifact.name} (HTTP ${response.status})；草稿保留，可重新运行`)
    const asset = await response.json()
    if (asset.size !== artifact.size || (asset.digest && asset.digest !== `sha256:${artifact.sha256}`)) throw new Error(`上传后校验失败: ${artifact.name}`)
    console.log(`上传并校验完成: ${artifact.name}`)
  }
  release = await api('GET', `/releases/${release.id}`)
  for (const artifact of local) {
    const asset = release.assets.find((a) => a.name === artifact.name && a.state === 'uploaded')
    if (!asset || asset.size !== artifact.size || (asset.digest && asset.digest !== `sha256:${artifact.sha256}`)) throw new Error(`发布前附件核验失败: ${artifact.name}`)
  }
  if (release.draft) release = await api('PATCH', `/releases/${release.id}`, { draft: false, make_latest: version.includes('-') ? 'false' : 'true' })
  console.log(`发布成功: ${release.html_url}`)
}

main().catch((error) => { console.error('发布未完成:', error.message); process.exitCode = 1 })
