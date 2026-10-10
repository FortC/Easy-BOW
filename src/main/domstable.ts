/**
 * T2/W1 统一 DOM 变动分类表 + 静默探针（W1 智能等待与 W10 动作后核验共用同一份常量）。
 *
 * 计入变动：childList/characterData 结构性增删、aria-*、disabled、checked、selected、
 *           value、hidden、role 属性变化；
 * 忽略：    style、class 中纯动画/过渡类、轮播/广告容器选择器黑名单内的子树增删、
 *           自注入的 data-easybow-* 句柄属性。
 * 探针覆盖穿透的每个 shadow root（含运行期新增的）。
 */

/** 属性变动中「计入静默判定」的属性名（精确 + 前缀） */
export const COUNTED_ATTRS = ['disabled', 'checked', 'selected', 'value', 'hidden', 'role']
export const COUNTED_ATTR_PREFIXES = ['aria-']

/** 属性变动中直接忽略的属性名 */
export const IGNORED_ATTRS = ['style', 'class']

/** class 变化若只涉及这些纯动画/过渡类，不算结构性变动 */
export const ANIMATION_CLASS_RE = /(animate|animation|transition|tween|hover|active|focus|loading|spinner|pulse|shake|fade|slide|ripple|progress)/i

/** 轮播/广告容器黑名单：其子树内的增删不计入静默判定（永不稳定的噪声源） */
export const NOISE_CONTAINER_SELECTORS = [
  '[class*="swiper"]',
  '[class*="carousel"]',
  '[class*="slide-"]',
  '[class*="banner"]',
  '[class*="marquee"]',
  '[class*="ad-"]',
  '[class*="advert"]',
  '[id*="ad_"]',
  '[id*="ads-"]',
  '[class*="countdown"]',
  '[class*="clock"]'
]

/** 自注入句柄属性前缀（探针/测试标记等，永不算页面变动） */
export const SELF_ATTR_PREFIX = 'data-easybow-'

/**
 * 页面内静默探针（自包含 String(function) 形式，cdp.evaluate 注入）：
 * 安装 MutationObserver 覆盖 document + 所有 shadow root（新增 host 自动挂载），
 * 按上面分类表判断「结构性变动」，连续 quietMs 无变动 → resolve(true)；
 * timeoutMs 必到（动画页/轮播页不卡死），resolve(false) 表示吃满上限未静默。
 */
export const WAIT_DOM_STABLE_FN = String(function waitDomStable(quietMs: number, timeoutMs: number) {
  // —— 分类表（与 domstable.ts 常量同步维护；页面函数自包含无法 import） ——
  var COUNTED_ATTRS = ['disabled', 'checked', 'selected', 'value', 'hidden', 'role']
  var COUNTED_PREFIXES = ['aria-']
  var IGNORED_ATTRS = ['style', 'class']
  var ANIM_RE = /(animate|animation|transition|tween|hover|active|focus|loading|spinner|pulse|shake|fade|slide|ripple|progress)/i
  var NOISE_SEL =
    '[class*="swiper"],[class*="carousel"],[class*="slide-"],[class*="banner"],[class*="marquee"],[class*="ad-"],[class*="advert"],[id*="ad_"],[id*="ads-"],[class*="countdown"],[class*="clock"]'
  var SELF_PREFIX = 'data-easybow-'

  function attrCounted(name: string): boolean {
    if (name.indexOf(SELF_PREFIX) === 0) return false
    if (IGNORED_ATTRS.indexOf(name) >= 0) return false
    if (COUNTED_ATTRS.indexOf(name) >= 0) return true
    for (var i = 0; i < COUNTED_PREFIXES.length; i++) {
      if (name.indexOf(COUNTED_PREFIXES[i]) === 0) return true
    }
    return false
  }

  function inNoise(node: any): boolean {
    try {
      var el = node && node.nodeType === 3 ? node.parentElement : node
      return !!(el && el.closest && el.closest(NOISE_SEL))
    } catch (e) {
      return false
    }
  }

  function mutationCounted(m: MutationRecord): boolean {
    if (inNoise(m.target)) return false
    if (m.type === 'characterData') return true
    if (m.type === 'childList') {
      // 轮播/广告容器内子树增删忽略；自注入句柄节点忽略
      if (m.addedNodes.length || m.removedNodes.length) return true
      return false
    }
    if (m.type === 'attributes') {
      var name = m.attributeName || ''
      if (name.indexOf(SELF_PREFIX) === 0) return false
      if (name === 'class') {
        // class 差分（MutationRecord 不带旧值，用基线记忆）：仅当新增/移除了
        // 「非纯动画类」才算结构性变动；首次见到的元素先落基线不计
        try {
          var t = m.target as Element
          var now = (t.getAttribute('class') || '').split(/\s+/).filter(Boolean)
          var prev: string[] | null = classBaseline.get(t) || null
          classBaseline.set(t, now)
          if (!prev) return false
          var diff = now.filter(function (c: string) {
            return prev!.indexOf(c) < 0 && !ANIM_RE.test(c)
          }).concat(
            prev.filter(function (c: string) {
              return now.indexOf(c) < 0 && !ANIM_RE.test(c)
            })
          )
          return diff.length > 0
        } catch (e) {
          return false
        }
      }
      return attrCounted(name)
    }
    return false
  }

  var classBaseline = new WeakMap()
  return new Promise(function (resolve) {
    var last = Date.now()
    var settled = false
    var observers: MutationObserver[] = []
    function done(quiet: boolean) {
      if (settled) return
      settled = true
      for (var i = 0; i < observers.length; i++) {
        try {
          observers[i].disconnect()
        } catch (e) {}
      }
      resolve(quiet)
    }
    function onMuts(muts: MutationRecord[]) {
      for (var i = 0; i < muts.length; i++) {
        if (mutationCounted(muts[i])) {
          last = Date.now()
          return
        }
      }
    }
    function observeRoot(root: Document | ShadowRoot) {
      try {
        var obs = new MutationObserver(function (muts) {
          onMuts(muts)
          // 运行期新增的 shadow host：挂载探针（覆盖穿透的每个 shadow root）
          for (var i = 0; i < muts.length; i++) {
            var m = muts[i]
            if (m.type !== 'childList') continue
            for (var j = 0; j < m.addedNodes.length; j++) {
              var n = m.addedNodes[j] as any
              if (!n || n.nodeType !== 1) continue
              if (n.shadowRoot && !n.shadowRoot.__easybowProbe) {
                n.shadowRoot.__easybowProbe = true
                observeRoot(n.shadowRoot)
              }
              var hosts = n.querySelectorAll ? n.querySelectorAll('*') : []
              for (var k = 0; k < hosts.length; k++) {
                var sr = (hosts[k] as any).shadowRoot
                if (sr && !sr.__easybowProbe) {
                  sr.__easybowProbe = true
                  observeRoot(sr)
                }
              }
            }
          }
        })
        obs.observe(root, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: undefined // 全属性监听，靠分类表过滤（attributeFilter 含不了前缀匹配）
        })
        ;(root as any).__easybowProbe = true
        observers.push(obs)
      } catch (e) {}
    }
    observeRoot(document)
    // 已存在的 shadow root 一次挂齐
    try {
      var all = document.querySelectorAll('*')
      for (var i = 0; i < all.length; i++) {
        var sr = (all[i] as any).shadowRoot
        if (sr && !sr.__easybowProbe) {
          sr.__easybowProbe = true
          observeRoot(sr)
        }
      }
    } catch (e) {}

    var t0 = Date.now()
    var timer = setInterval(function () {
      if (Date.now() - last >= quietMs) {
        clearInterval(timer)
        done(true)
      } else if (Date.now() - t0 >= timeoutMs) {
        clearInterval(timer)
        done(false)
      }
    }, 60)
  })
})
