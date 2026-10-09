/**
 * 自愈智能 S2 —— 失败分类学（纯函数）。
 *
 * 现状短板：runner 原来只识别「定位失败」一类错误；真实失败至少七类，
 * 其余六类不产生 error 字段，自愈兜底永不触发。本模块按「先具体后一般」
 * 的优先级把失败归类，产出可直接注入下一步提示词的人话 hint 与恢复策略。
 */
import type { AgentAction } from '@shared/types'
import type { ExtractResult } from './extractor'

export type FailureKind =
  | 'locate' // 定位失败：元素失效/不可见/找不到
  | 'semantic' // 语义选错：填进了语义不匹配的字段（S1 填后校验产生）
  | 'page_changed' // 页面异变：URL 变了且非本批动作预期所致
  | 'data_missing' // 数据取不到（read_content 空 / 图片抓不到）
  | 'verify_fail' // 复核未通过（节点链路径已有处理，这里仅归档）
  | 'loop' // 循环：同一动作连续失败 ≥3
  | 'exhausted' // 步数耗尽

export type FailureStrategy = 'retry' | 'rerank' | 'reextract' | 'replan' | 'escalate' | 'abort'

export interface Diagnosis {
  kind: FailureKind
  /** 给模型看的人话，直接注入下一步提示词 */
  hint: string
  strategy: FailureStrategy
}

export interface DiagnoseInput {
  /** 本批已执行的动作（带 error/result 回填） */
  actions: AgentAction[]
  extract: ExtractResult
  /** 上一步的提取快照（URL 对比判定 page_changed） */
  prevExtract?: ExtractResult
  /** 同一动作名连续失败次数（调用方维护） */
  sameActionStreak: number
  stepNo: number
  maxSteps: number
}

const LOCATE_RE = /已失效|不可见|找不到|无法定位|没有可点击|超出范围/
const DATA_EMPTY_RE = /页面没有可读文本|没有抓到图片资源|提取结果为空/

function sameOriginPath(a: string, b: string): boolean {
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    return ua.host === ub.host && ua.pathname.replace(/\/+$/, '') === ub.pathname.replace(/\/+$/, '')
  } catch {
    return a === b
  }
}

/** 失败分类：按优先级先具体后一般；识别不出返回 null（不介入，交给模型自纠错） */
export function diagnose(input: DiagnoseInput): Diagnosis | null {
  const { actions, extract, prevExtract, sameActionStreak, stepNo, maxSteps } = input
  const errored = actions.filter((a) => a.error)

  // 8. 步数耗尽
  if (stepNo >= maxSteps) {
    return {
      kind: 'exhausted',
      strategy: 'abort',
      hint: `已达最大步数 ${maxSteps}，任务未完成。`
    }
  }

  // 1. 定位失败（最高频，原有唯一识别的一类）
  if (errored.some((a) => LOCATE_RE.test(String(a.error)))) {
    return {
      kind: 'locate',
      strategy: 'reextract',
      hint: '系统诊断: 目标元素定位失败（元素已失效/不可见/不存在）。页面可能已变化：请完全以本次最新元素列表为准重新选择目标；列表里没有目标时先 scroll 滚动后再找，视觉兜底开启时可用 click_xy 按截图坐标点击。'
    }
  }

  // 2. 语义选错（S1 填后校验显式报出——静默错误已归零）
  if (errored.some((a) => String(a.error).includes('疑似填错字段'))) {
    return {
      kind: 'semantic',
      strategy: 'rerank',
      hint: '系统诊断: 疑似填错字段——值填进去了，但该输入框的语义与任务目标不匹配。请放弃刚才的输入框，改选元素列表「语义匹配提示」里与目标字段最接近的输入框重新填写。'
    }
  }

  // 3. 页面异变：URL 的主机/路径变了，且本批没有 goto/back/forward/click（点击后的正常跳转不算异变）
  if (prevExtract && extract.url && prevExtract.url && !sameOriginPath(prevExtract.url, extract.url)) {
    const noNav = !actions.some((a) => ['goto', 'back', 'forward', 'click', 'new_tab', 'switch_tab'].includes(a.name))
    if (noNav) {
      return {
        kind: 'page_changed',
        strategy: 'reextract',
        hint: '系统诊断: 页面发生了意外跳转或变化（URL 已改变，非本批动作所致，可能有弹窗接管/重定向）。请基于最新元素列表与页面状态重新判断当前位置，必要时后退或重新导航，不要基于旧认知继续操作。'
      }
    }
  }

  // 5. 数据取不到（不产生 error，靠 result 文案识别）
  if (
    actions.some(
      (a) => !a.error && (a.name === 'read_content' || a.name === 'extract_images') && DATA_EMPTY_RE.test(String(a.result || ''))
    )
  ) {
    return {
      kind: 'data_missing',
      strategy: 'retry',
      hint: '系统诊断: 页面数据读取为空（内容可能懒加载/在视口外/为图片型内容）。可先 scroll 到目标区域、wait 等待加载后重试读取；图片型页面改用 extract_images 或 OCR 兜底。'
    }
  }

  // 7. 循环：同一动作连续失败 ≥3
  if (sameActionStreak >= 3) {
    return {
      kind: 'loop',
      strategy: 'escalate',
      hint: `系统诊断: 动作「${errored[0]?.name || ''}」连续失败 ${sameActionStreak} 次，已触发循环保护。`
    }
  }

  return null
}
