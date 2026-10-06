/**
 * 复评时效工具：判断营位最新一轮现场实测是否仍在权重方案要求的有效期内。
 *
 * 规则：
 *   - 权重方案各带 reviewDays（雨季两周 / 旱季一个月，可自定义）；
 *   - 营位取「最新一轮」因子评估，自评估日（assessedAt，按天）起算；
 *   - 超过时效仍未补录新一轮实测 → 退出本批比较，标为「待复评」；
 *   - 补录新一轮实测（评估日期进入有效期）→ 立即回到比较，清除待复评标记。
 *
 * 日期一律按「自然日」比较（YYYY-MM-DD），避免时分秒让同一天录入的数据被判超期。
 */
import type { FactorAssessment } from '@/types/factor'
import { DEFAULT_REVIEW_DAYS, MAX_REVIEW_DAYS, MIN_REVIEW_DAYS } from '@/types/score'

/** 取「今天」的日期字符串（YYYY-MM-DD），集中一处便于测试与对齐。 */
export function todayKey(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * 两个 YYYY-MM-DD 日期相差的整天数（b - a）。
 * 只做字符串解析，不依赖时区；无法解析时返回 null。
 */
export function daysBetween(a: string, b: string): number | null {
  if (!a || !b) return null
  const pa = /^(\d{4})-(\d{2})-(\d{2})/.exec(a)
  const pb = /^(\d{4})-(\d{2})-(\d{2})/.exec(b)
  if (!pa || !pb) return null
  const da = new Date(Number(pa[1]), Number(pa[2]) - 1, Number(pa[3]))
  const db = new Date(Number(pb[1]), Number(pb[2]) - 1, Number(pb[3]))
  return Math.round((db.getTime() - da.getTime()) / 86_400_000)
}

/** 规整方案时效为合法正整数天，异常值回落默认口径。 */
export function normalizeReviewDays(days: unknown): number {
  const n = Number(days)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REVIEW_DAYS
  return Math.min(MAX_REVIEW_DAYS, Math.max(MIN_REVIEW_DAYS, Math.round(n)))
}

export interface FreshnessResult {
  /** 最新一轮评估日期；营位从未实测时为 null（也算待复评，但没有到期日）。 */
  assessedAt: string | null
  /** 复评截止日期（YYYY-MM-DD），即评估日 + reviewDays。 */
  dueAt: string | null
  /** 已过去的天数（今天 - 评估日）；可能为负（补录了未来日期时）。 */
  elapsedDays: number | null
  /** 距离复评截止还剩几天（负数表示已超期几天）。 */
  daysLeft: number | null
  /** 是否仍在有效期内、可参与本批比较。 */
  fresh: boolean
  /** 超期未复评：退出比较并标记「待复评」。 */
  overdue: boolean
  /** 从未做过现场实测。 */
  neverAssessed: boolean
}

/**
 * 评估单条营位的时效状态。
 * @param latest 最新一轮因子评估（按评估日倒序的第一条）
 * @param reviewDays 当前权重方案的复评时效（天）
 */
export function assessFreshness(
  latest: FactorAssessment | null | undefined,
  reviewDays: number,
  now: Date = new Date()
): FreshnessResult {
  const days = normalizeReviewDays(reviewDays)
  const today = todayKey(now)

  if (!latest || !latest.assessedAt) {
    return {
      assessedAt: null,
      dueAt: null,
      elapsedDays: null,
      daysLeft: null,
      fresh: false,
      overdue: false,
      neverAssessed: true
    }
  }

  const assessedAt = latest.assessedAt.slice(0, 10)
  const elapsed = daysBetween(assessedAt, today)
  if (elapsed === null) {
    return {
      assessedAt,
      dueAt: null,
      elapsedDays: null,
      daysLeft: null,
      fresh: false,
      overdue: false,
      neverAssessed: true
    }
  }

  const dueDate = new Date(
    Number(assessedAt.slice(0, 4)),
    Number(assessedAt.slice(5, 7)) - 1,
    Number(assessedAt.slice(8, 10)) + days
  )
  const pad = (n: number): string => String(n).padStart(2, '0')
  const dueAt = `${dueDate.getFullYear()}-${pad(dueDate.getMonth() + 1)}-${pad(dueDate.getDate())}`
  const daysLeft = days - elapsed
  // 评估当天即第 0 天，仍在有效期；超过 reviewDays 天才算超期。
  const fresh = elapsed >= 0 && elapsed <= days

  return {
    assessedAt,
    dueAt,
    elapsedDays: elapsed,
    daysLeft,
    fresh,
    overdue: !fresh,
    neverAssessed: false
  }
}

/**
 * 待复评判定（供页面 / 地图着色复用）：
 * 从未实测的营位没有「超期」，也不参与比较，但语义上单独提示；
 * 这里把「从未实测」与「已超期」都视为不参与本批比较，
 * 只有已超期才打上「待复评」标记（neverAssessed 由调用方自行决定文案）。
 */
export function isPendingReview(freshness: FreshnessResult): boolean {
  return freshness.overdue
}

/** 待复评的统一展示色（地图标记 / 标签共用，区别于 A/B/C 三色）。 */
export const PENDING_COLOR = '#6b7280'

export const PENDING_LABEL = '待复评'
