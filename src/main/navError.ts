/**
 * 把 Electron/Chromium loadURL 的原始报错翻译成用户能看懂的中文。
 * 原始报错形如：`ERR_CONNECTION_REFUSED (-102) loading 'http://localhost:8081/...'`
 * 直接透给用户是天书；这里映射错误码 → 中文原因，并截断 URL。
 */

const NAV_ERROR_REASONS: Record<string, string> = {
  ERR_CONNECTION_REFUSED: '目标服务未启动或端口未开放（连接被拒绝），请确认该服务已运行',
  ERR_NAME_NOT_RESOLVED: '域名无法解析（网址可能有误，或网络/DNS 异常）',
  ERR_CONNECTION_TIMED_OUT: '连接超时（网络不通或服务响应过慢）',
  ERR_TIMED_OUT: '连接超时（网络不通或服务响应过慢）',
  ERR_INTERNET_DISCONNECTED: '网络已断开，请检查网络连接',
  ERR_CONNECTION_RESET: '连接被重置（服务异常中断或网络不稳定）',
  ERR_CONNECTION_CLOSED: '连接被关闭（服务异常中断）',
  ERR_ADDRESS_UNREACHABLE: '网络地址不可达',
  ERR_EMPTY_RESPONSE: '服务器未返回数据（可能正在重启或已崩溃）',
  ERR_SSL_PROTOCOL_ERROR: 'HTTPS 协议错误（站点证书异常）',
  ERR_CERT_AUTHORITY_INVALID: '站点证书不受信任',
  ERR_CERT_COMMON_NAME_INVALID: '站点证书域名不匹配',
  ERR_CERT_DATE_INVALID: '站点证书已过期或未生效',
  ERR_FILE_NOT_FOUND: '本地文件不存在',
  ERR_ACCESS_DENIED: '访问被拒绝',
  ERR_BLOCKED_BY_CLIENT: '请求被拦截（安全/广告拦截软件）',
  ERR_TOO_MANY_REDIRECTS: '重定向次数过多（站点配置异常）',
  ERR_INVALID_URL: '网址格式无效',
  ERR_HTTP2_PROTOCOL_ERROR: 'HTTP/2 协议错误（服务器异常）',
  ERR_PROXY_CONNECTION_FAILED: '代理服务器连接失败，请检查系统代理'
}

/** URL 展示上限：超过则截断加省略号，避免 toast 被长路径撑爆 */
const URL_MAX = 64

/**
 * 生成友好的导航错误文案。
 * 返回 null 表示不值得打扰用户（如 ERR_ABORTED：页面自身跳转/新导航接管，不是真实故障）。
 */
export function friendlyNavError(e: unknown): string | null {
  const raw = e instanceof Error ? e.message : String(e ?? '')
  const code = raw.match(/ERR_[A-Z0-9_]+/)?.[0]
  // ERR_ABORTED：导航被新的跳转接管（重定向/用户又触发导航/页面刷新），属正常现象，静默
  if (code === 'ERR_ABORTED') return null
  const url = raw.match(/'([^']+)'/)?.[1] ?? ''
  const shortUrl = url.length > URL_MAX ? url.slice(0, URL_MAX - 1) + '…' : url
  const reason = code ? NAV_ERROR_REASONS[code] || `网络错误（${code}）` : raw.slice(0, 80)
  return shortUrl ? `${reason}｜${shortUrl}` : reason
}
