/**
 * 复评时效工具：判定营位最新一轮实测是否超期。
 *
 * 现场实测读数会随季节天气变化失效（雨季约两周、旱季约一个月），
 * 超期的营位退出本批比较并标记「待复评」，补录新一轮实测后自动回到比较。
 * 全部为纯函数，便于 useRanking 与各页面复用。
 */
import type { FactorAssessment } from '@/types/factor'
import { todayIso } from '@/utils/format'

/** 待复评营位的展示色（名次表、地图标记、等级徽章共用） */
export const STALE_COLOR = '#6b7280'

/** 两个 YYYY-MM-DD 日期之间相差的整天数（to - from）。 */
export function daysBetweenDate(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`)
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / 86400000)
}

/** 单个营位的复评状态 */
export interface ReviewStatus {
  /** 是否超期（超期即退出比较、标记待复评） */
  expired: boolean
  /** 最新一轮实测日期；从未评估时为 null */
  assessedAt: string | null
  /** 实测读数已过去的天数；从未评估时为 null */
  elapsedDays: number | null
  /** 超期天数（>0 表示已超期多久）；未超期或从未评估时为 0 */
  overdueDays: number
  /** 采用的时效天数 */
  validDays: number
}

/**
 * 计算某营位在指定时效下的复评状态。
 * 从未录入实测的营位同样视为待复评（没有有效读数可参与比较）。
 */
export function reviewStatusOf(
  factor: FactorAssessment | null | undefined,
  validDays: number,
  today: string = todayIso()
): ReviewStatus {
  const days = Number.isFinite(validDays) && validDays > 0 ? Math.floor(validDays) : 30
  const assessedAt = factor?.assessedAt ? factor.assessedAt.slice(0, 10) : null
  if (!assessedAt) {
    return { expired: true, assessedAt: null, elapsedDays: null, overdueDays: 0, validDays: days }
  }
  const elapsed = daysBetweenDate(assessedAt, today)
  const overdue = elapsed - days
  return {
    expired: overdue > 0,
    assessedAt,
    elapsedDays: elapsed,
    overdueDays: Math.max(0, overdue),
    validDays: days
  }
}

/** 便捷判定：该营位最新实测是否已超期。 */
export function isReviewExpired(
  factor: FactorAssessment | null | undefined,
  validDays: number,
  today: string = todayIso()
): boolean {
  return reviewStatusOf(factor, validDays, today).expired
}
