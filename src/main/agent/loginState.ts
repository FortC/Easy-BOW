/**
 * 登录态探测（测试模式「登录态复用」用）。
 *
 * 背景：测试页签跑在独立持久分区 persist:easybow-test 上，Cookie/localStorage 会跨次保留。
 * 回归用例每次都从「打开登录页 → 输账号密码 → 点登录」开始，第二次起其实早已登录，
 * 重复登录既慢又容易触发风控/验证码。这里在测试启动与每一步前做轻量探测：
 *   - 已登录 → 跳过登录类步骤（步骤标 passed 并注明「复用已保存登录态」）
 *   - 未登录 / 会话过期（被踢回登录页）→ 正常执行登录；非登录步骤踩到登录页时提示模型
 */
import type { Tab } from '../tabs'
import type { TestCase, TestStep } from '@shared/types'

/** 页面侧登录态探针（注入页面主 frame 执行一次，廉价、无副作用） */
export const LOGIN_PROBE_FN = String(function probeLogin() {
  const out = {
    url: location.href || '',
    title: '',
    /** 页面上有「密码框 + 账号框」或明确的登录按钮 → 处在登录页 */
    hasLoginForm: false,
    /** 页面上出现退出/注销/个人中心等登录后特征 → 已登录 */
    hasLogoutSignal: false,
    /** storage/cookie 里存在 token 类键（辅助信号，不作为唯一依据） */
    authKeys: [] as string[]
  }
  try {
    out.title = document.title || ''
  } catch {}
  try {
    const pwd = document.querySelector('input[type="password"]')
    const userSel =
      'input[autocomplete="username"],input[name*="user" i],input[name*="account" i],input[name*="login" i],input[id*="user" i],input[id*="account" i],input[placeholder*="用户"],input[placeholder*="账号"],input[placeholder*="邮箱"],input[placeholder*="手机"]'
    const user = document.querySelector(userSel)
    const bodyText = (document.body ? document.body.innerText || '' : '').slice(0, 4000)
    const loginBtn = /(^|\n|\s)(登录|登 录|登陆|登\s*录|Sign in|Log in|Sign In|Log In|立即登录)(\s|$)/.test(bodyText)
    // 密码框是最强的登录页信号；只有账号框不足以判定（很多页面顶部自带搜索框）
    out.hasLoginForm = !!pwd && (!!user || loginBtn)
    const logoutRe = /(退出登录|退出登陆|登出|注销|退出|Sign out|Log out|Sign Out|Log Out|我的账户|个人中心|账号设置)/
    out.hasLogoutSignal = logoutRe.test(bodyText)
  } catch {}
  try {
    const re = /token|auth|session|sid|jwt|login|uid|user_?id|accesskey/i
    const push = (k: string) => {
      if (re.test(k)) out.authKeys.push(k.slice(0, 32))
    }
    for (let i = 0; i < localStorage.length; i++) push(localStorage.key(i) || '')
    for (let i = 0; i < sessionStorage.length; i++) push(sessionStorage.key(i) || '')
    const ck = document.cookie || ''
    ck.split(';').forEach((c) => push(c.split('=')[0].trim()))
  } catch {}
  return out
})

/** URL 是否像登录页（探针之外的第二路信号，页面脚本执行失败时仍可用） */
const LOGIN_URL_RE = /\/((login|signin|sign-in|sign_in|passport|auth|sso|session\/new|logout)|.*login.*)(\?|#|$)/i

export interface LoginProbe {
  /** 明确已登录（页面出现登录后特征） */
  loggedIn: boolean
  /** 明确处在登录页（需要登录） */
  needLogin: boolean
  /** 供日志/提示的探测摘要 */
  detail: string
}

/**
 * 探测当前页登录态。
 * 判定优先级：URL 登录页 + 表单 → needLogin；退出/注销等登录后特征 → loggedIn；
 * 都不是 → 未知（unknown），此时**不改变**既有判断（保守：不跳过登录步骤）。
 */
export async function probeLoginState(tab: Tab | undefined): Promise<LoginProbe> {
  const empty: LoginProbe = { loggedIn: false, needLogin: false, detail: '无可用页签' }
  if (!tab) return empty
  let p: { url: string; title: string; hasLoginForm: boolean; hasLogoutSignal: boolean; authKeys: string[] } | undefined
  try {
    p = await tab.cdp.evaluate<{
      url: string
      title: string
      hasLoginForm: boolean
      hasLogoutSignal: boolean
      authKeys: string[]
    }>(LOGIN_PROBE_FN, [])
  } catch (e: any) {
    return { loggedIn: false, needLogin: false, detail: `探针失败: ${e?.message || e}` }
  }
  const url = p?.url || ''
  const urlLogin = LOGIN_URL_RE.test(url) && !p?.hasLogoutSignal
  const needLogin = !!p?.hasLoginForm || urlLogin
  const loggedIn = !!p?.hasLogoutSignal && !needLogin
  const keys = (p?.authKeys || []).slice(0, 3).join(',')
  const detail = `url=${url.slice(0, 60)} form=${!!p?.hasLoginForm} logout=${!!p?.hasLogoutSignal}${keys ? ` keys=${keys}` : ''}`
  return { loggedIn, needLogin, detail }
}

/** 步骤是否被识别为「登录类」（登录态复用时其操作可跳过） */
const LOGIN_STEP_RE = /(登录|登陆|sign\s*in|log\s*in)/i

export function isLoginStep(step: TestStep | undefined): boolean {
  if (!step) return false
  if (step.login) return true
  return LOGIN_STEP_RE.test(step.title) || LOGIN_STEP_RE.test(step.action)
}

/**
 * 从用例里挑一个「预热 URL」：登录态探测必须先真的访问目标站点，
 * 否则分区里的 Cookie 无法体现在页面上（about:blank 探测没有任何意义）。
 * 优先取环境 base_url，其次取步骤里第一个 http(s) 地址。
 */
export function pickWarmupUrl(tc: TestCase, baseUrl?: string): string | undefined {
  if (baseUrl && /^https?:/i.test(baseUrl)) return baseUrl.replace(/\/+$/, '')
  for (const s of tc.steps) {
    const m = s.action.match(/https?:\/\/[^\s，,）)"'」』]+/i)
    if (m) return m[0].replace(/[.,;。，；]+$/, '')
  }
  return undefined
}
