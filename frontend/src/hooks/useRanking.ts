/**
 * useRanking —— 读取营位、因子、权重与否决记录，算出归一化得分与名次。
 * 被 `/`（名次表）、`/scoring`（拖动权重实时重排）、`/map`、`/sites/:id`、`/veto` 共同消费。
 *
 * 复评时效：
 *   权重方案各带 reviewDays。营位取最新一轮现场实测，超过有效期且未补录新一轮的，
 *   **退出这一批比较**（不进入极差归一的样本，也不占名次 / 等级 / A 级数量 / 地图等级色），
 *   标为「待复评」；其余营位按**同一口径重新归一**后排名次、定等级。
 *   补录新一轮实测（日期回到有效期内）后自动回到比较。
 *
 * 入参统一用 getter 函数，兼容 ref / computed / store 派生值，
 * 内部在独立 effectScope 中求值，保证 computed 依赖追踪正常且不泄漏。
 */
import { computed, effectScope, ref, type ComputedRef } from 'vue'
import type { Campsite } from '@/types/campsite'
import type { FactorAssessment } from '@/types/factor'
import type { FactorKey, FactorWeights, GradeThresholds, NormalizeMethod } from '@/types/score'
import {
  buildFactorRows,
  buildNormalizedMatrix,
  gradeOf,
  rawValuesOf,
  weightedTotal,
  type Grade,
  type RawFactorValues,
  type SiteScore
} from '@/utils/score'
import { assessFreshness, todayKey, type FreshnessResult } from '@/utils/freshness'

/**
 * 全局「今天」刻度：跨自然日 / 标签页从后台回到前台时刷新一次。
 * 让长时间开着的页面也能在到期日当天自动把营位移入「待复评」，无需手动刷新。
 */
const todayTick = ref(todayKey())
let todayTimer: ReturnType<typeof setInterval> | null = null

function refreshTodayTick(): void {
  const key = todayKey()
  if (todayTick.value !== key) todayTick.value = key
}

function ensureTodayTimer(): void {
  if (todayTimer !== null) return
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  todayTimer = setInterval(refreshTodayTick, 60_000)
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('focus', refreshTodayTick)
}

function onVisibilityChange(): void {
  if (!document.hidden) refreshTodayTick()
}

// 模块加载即启动计时（SPA 生命周期内只建一次）。
ensureTodayTimer()


export interface RankingInput {
  /** 参与排名的营位集合（时效过滤前的全集，由调用方按筛选条件裁剪） */
  sites: () => Campsite[]
  /** siteId -> 用于评分的因子记录（通常取最新一轮评估） */
  factorOf: (siteId: number) => FactorAssessment | null
  weights: () => FactorWeights
  normalize: () => NormalizeMethod
  thresholds: () => GradeThresholds
  /** 当前方案的复评时效（天）；超期营位退出本批比较 */
  reviewDays: () => number
  /** 命中否决项的营位 id 集合 */
  vetoedIds: () => number[]
}

interface EvaluatedEntry {
  site: Campsite & { id: number }
  factor: FactorAssessment | null
  freshness: FreshnessResult
}

export interface RankingRow extends SiteScore {
  site: Campsite
  rank: number
  raw: RawFactorValues
  vetoTypes: string[]
  /** 最新一轮实测的时效状态 */
  freshness: FreshnessResult
  /** 超期未复评，已退出本批比较（待复评） */
  pendingReview: boolean
  /** 从未录入现场实测 */
  neverAssessed: boolean
}

export interface RankingState {
  /** 已按得分降序排列的名次（仅在有效期内的营位，超期营位不在其中） */
  ranked: ComputedRef<RankingRow[]>
  /** 超期未复评、退出本批比较的营位（待复评），保持与入参相同的顺序 */
  pending: ComputedRef<RankingRow[]>
  /** 全部营位（在比 + 待复评）按 id 索引，详情页 / 地图查询时不漏掉待复评营位 */
  rowsById: ComputedRef<Map<number, RankingRow>>
  scoreOf: (siteId: number) => RankingRow | null
  gradeOfSite: (siteId: number) => Grade
  /** 待复评营位返回 'pending'（地图 / 标签显示待复评色），在比营位返回真实等级 */
  statusOfSite: (siteId: number) => Grade | 'pending'
  best: ComputedRef<RankingRow | null>
}

/** 待复评行不参与归一，明细留空（归一值无意义），仅保留原始读数供详情页展示。 */
function emptyNormalized(): Record<FactorKey, number> {
  return {
    slope: NaN,
    flatness: NaN,
    aspect: NaN,
    waterDistance: NaN,
    wind: NaN,
    signal: NaN,
    sun: NaN,
    rockfall: NaN,
    shade: NaN,
    distanceToCar: NaN,
    distanceToTrail: NaN
  }
}

export function useRanking(input: RankingInput): RankingState {
  const scope = effectScope(true)

  /**
   * 一次性算出全集的时效与「在比 / 待复评」分组。
   * 极差归一只对在比营位取样，保证过期营位退出后其余营位按同一口径重新归一。
   */
  const evaluated = scope.run(() =>
    computed(() => {
      const sites = input.sites() ?? []
      const reviewDays = input.reviewDays()
      // 依赖全局「今天」刻度：跨天后不刷新页面也会重新判定时效。
      void todayTick.value
      const now = new Date(`${todayTick.value}T12:00:00`)
      const list = sites.filter((s): s is Campsite & { id: number } => typeof s.id === 'number')

      const all: EvaluatedEntry[] = list.map((site) => {
        const factor = input.factorOf(site.id)
        return {
          site,
          factor,
          freshness: assessFreshness(factor, reviewDays, now)
        }
      })

      // 只有「未超期」的营位进入本批比较；从未实测的营位沿用保守缺省值继续在比。
      return {
        active: all.filter((e) => !e.freshness.overdue),
        overdue: all.filter((e) => e.freshness.overdue)
      }
    })
  ) as ComputedRef<{ active: EvaluatedEntry[]; overdue: EvaluatedEntry[] }>

  const ranked = scope.run(() =>
    computed<RankingRow[]>(() => {
      const normalize = input.normalize()
      const weights = input.weights()
      const thresholds = input.thresholds()
      const vetoSet = new Set(input.vetoedIds() ?? [])
      const { active } = evaluated.value

      // 关键：极差归一必须**同批营位一起比较**。待复评营位退出后，
      // 只对仍在有效期内的营位收集原始指标并一次性归一，名次 / 等级随之重算。
      const entries = active.map(({ site, factor }) => ({
        siteId: site.id,
        values: rawValuesOf(site, factor)
      }))
      const matrix = buildNormalizedMatrix(entries, normalize)

      const rows: RankingRow[] = active.map(({ site, freshness }, idx) => {
        const siteId = site.id
        const raw = entries[idx].values
        const normalized = matrix.get(siteId) ?? ({} as Record<FactorKey, number>)
        const vetoed = vetoSet.has(siteId)
        const total = weightedTotal(normalized, weights)
        return {
          site,
          siteId,
          total,
          grade: gradeOf(total, thresholds, vetoed),
          vetoed,
          vetoTypes: [],
          rows: buildFactorRows(normalized, weights).map((row) => ({ ...row, raw: raw[row.key] })),
          raw,
          rank: 0,
          freshness,
          pendingReview: false,
          neverAssessed: freshness.neverAssessed
        } satisfies RankingRow
      })

      const sorted = rows.sort((a, b) => b.total - a.total)
      sorted.forEach((row, idx) => {
        row.rank = idx + 1
      })
      return sorted
    })
  ) as ComputedRef<RankingRow[]>

  /** 待复评营位：退出本批比较，不参与归一、不占名次等级，仅保留现场信息供补录。 */
  const pending = scope.run(() =>
    computed<RankingRow[]>(() => {
      const weights = input.weights()
      const vetoSet = new Set(input.vetoedIds() ?? [])
      return evaluated.value.overdue.map(({ site, factor, freshness }) => {
        const siteId = site.id
        const raw = rawValuesOf(site, factor)
        return {
          site,
          siteId,
          // 退出比较：总分与等级不再给出有效值，避免被计入 A 级数量或误用等级色。
          total: NaN,
          grade: 'C' as Grade,
          vetoed: vetoSet.has(siteId),
          vetoTypes: [],
          rows: buildFactorRows(emptyNormalized(), weights).map((row) => ({
            ...row,
            raw: raw[row.key],
            normalized: NaN,
            contribution: 0
          })),
          raw,
          rank: 0,
          freshness,
          pendingReview: true,
          neverAssessed: false
        } satisfies RankingRow
      })
    })
  ) as ComputedRef<RankingRow[]>

  const rowsById = scope.run(() =>
    computed<Map<number, RankingRow>>(() => {
      const map = new Map<number, RankingRow>()
      for (const r of ranked.value) map.set(r.siteId, r)
      for (const r of pending.value) map.set(r.siteId, r)
      return map
    })
  ) as ComputedRef<Map<number, RankingRow>>

  function scoreOf(siteId: number): RankingRow | null {
    return rowsById.value.get(siteId) ?? null
  }

  function gradeOfSite(siteId: number): Grade {
    const row = scoreOf(siteId)
    // 待复评营位没有有效等级，地图 / 标签应改用 statusOfSite 显示「待复评」。
    if (!row || row.pendingReview) return 'C'
    return row.grade
  }

  function statusOfSite(siteId: number): Grade | 'pending' {
    const row = scoreOf(siteId)
    if (row?.pendingReview) return 'pending'
    return row?.grade ?? 'C'
  }

  const best = scope.run(() => computed<RankingRow | null>(() => ranked.value[0] ?? null)) as
    | ComputedRef<RankingRow | null>
    | undefined

  return {
    ranked,
    pending,
    rowsById,
    scoreOf,
    gradeOfSite,
    statusOfSite,
    best: best ?? computed<RankingRow | null>(() => ranked.value[0] ?? null)
  }
}
