/**
 * 一键发布到 GitHub：推送分支/标签 → 创建 Release → 上传安装包附件。
 *
 * 设计要点：
 * - 凭证不落盘：PAT 从 Git Credential Manager 取（`git credential fill`），仅存在于本进程内存
 * - 网络：默认走 ghfast.top 加速（直连 GitHub 在国内通常不通）；可用 GH_HOST/PROXY 环境变量覆盖
 * - 幂等：Release 已存在则跳过创建，附件已存在则跳过上传
 *
 * 用法：
 *   node scripts/publish-github.mjs --version 1.2.2 --notes dist/release-notes-v1.2.2.md
 *   node scripts/publish-github.mjs --version 1.2.2 --notes notes.md --skip-upload
 */
import { spawnSync } from 'child_process'
import { existsSync, statSync } from 'fs'
import { basename, join } from 'path'

const argv = process.argv.slice(2)
const arg = (k, d = '') => {
  const i = argv.indexOf(`--${k}`)
  return i === -1 ? d : argv[i + 1]
}
const flag = (k) => argv.includes(`--${k}`)

const VERSION = arg('version')
const NOTES = arg('notes')
const HOST = process.env.GH_HOST || 'ghfast.top' // ghfast.top / gh-proxy.com / ghproxy.net
const OWNER_REPO = process.env.GH_REPO || 'FortC/Easy-BOW'
const API = `https://${HOST}/https://api.github.com/repos/${OWNER_REPO}`
const UPLOADS = `https://${HOST}/https://uploads.github.com/repos/${OWNER_REPO}`
const TAG = `v${VERSION}`

if (!VERSION) {
  console.error('缺少 --version，例如：node scripts/publish-github.mjs --version 1.2.2 --notes notes.md')
  process.exit(1)
}

/** 从环境变量或凭据管理器取 PAT（任何途径都不打印明文） */
function getToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim()
  const r = spawnSync('git', ['credential', 'fill'], {
    input: `protocol=https\nhost=${HOST}\n\n`,
    encoding: 'utf8'
  })
  const m = (r.stdout || '').match(/^password=(.+)$/m)
  if (!m) {
    throw new Error(
      `拿不到 ${HOST} 的凭证。两种方式任选：\n` +
        `  1) 先登录一次：git push https://${HOST}/https://github.com/${OWNER_REPO}.git\n` +
        `  2) 或直接给环境变量：GH_TOKEN=<PAT> node scripts/publish-github.mjs ...`
    )
  }
  return m[1].trim()
}

const TOKEN = getToken()
const auth = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'easybow-publish' }

async function api(method, url, body, extraHeaders = {}) {
  const res = await fetch(url, { method, headers: { ...auth, ...extraHeaders }, body })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

async function main() {
  console.log(`仓库 ${OWNER_REPO}｜标签 ${TAG}｜代理 ${HOST}`)
  const rel = await api('GET', `${API}/releases/tags/${TAG}`).catch(() => null)
  const release = rel ?? (await api('POST', `${API}/releases`, JSON.stringify({
    tag_name: TAG,
    name: TAG,
    body: NOTES && existsSync(NOTES) ? (await import('fs')).readFileSync(NOTES, 'utf8') : '',
    draft: false,
    prerelease: false
  }), { 'Content-Type': 'application/json' }))
  console.log(release.id ? `Release 就绪：${release.html_url}` : 'Release 创建失败')

  if (flag('skip-upload')) return
  const distDir = arg('dir', 'dist')
  const want = [`EasyBow-Setup-${VERSION}.exe`, `EasyBow-Portable-${VERSION}.exe`, `EasyBow-Setup-${VERSION}.exe.blockmap`]
  const have = new Set((release.assets || []).map((a) => a.name))
  for (const name of want) {
    const file = join(distDir, name)
    if (!existsSync(file)) {
      console.log(`跳过（不存在）：${name}`)
      continue
    }
    if (have.has(name)) {
      console.log(`跳过（已存在）：${name}`)
      continue
    }
    const mb = (statSync(file).size / 1048576).toFixed(0)
    process.stdout.write(`上传 ${name}（${mb}MB）… `)
    const t0 = Date.now()
    // 附件数百 MB，必须流式上传，不能整体读进内存
    const { createReadStream } = await import('fs')
    const res = await fetch(`${UPLOADS}/releases/${release.id}/assets?name=${encodeURIComponent(basename(name))}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/octet-stream' },
      body: createReadStream(file),
      duplex: 'half'
    })
    if (!res.ok) throw new Error(`上传 ${name} 失败：${res.status} ${(await res.text()).slice(0, 200)}`)
    console.log(`完成（${((Date.now() - t0) / 1000).toFixed(0)}s）`)
  }
  console.log(`完成：${API}/releases/tag/${TAG}`)
}

main().catch((e) => {
  console.error('发布失败：', e.message)
  process.exit(1)
})
