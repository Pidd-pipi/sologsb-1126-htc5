/**
 * useRanking —— 读取营位、因子、权重与否决记录，算出归一化得分与名次。
 * 被 `/`（名次表）、`/scoring`（拖动权重实时重排）共同消费。
 *
 * 复评时效：最新实测超过方案时效（reviewValidDays）的营位退出本批比较，
 * 其余营位按同一口径重新归一；超期营位进入 stale 列表并标记「待复评」，
 * 补录新一轮实测后（最新评估日期回到时效内）自动回到比较。
 *
 * 入参统一用 getter 函数，兼容 ref / computed / store 派生值，
 * 内部在独立 effectScope 中求值，保证 computed 依赖追踪正常且不泄漏。
 */
import { computed, effectScope, type ComputedRef } from 'vue'
import type { Campsite } from '@/types/campsite'
import type { FactorAssessment } from '@/types/factor'
import type { FactorKey, FactorWeights, GradeThresholds, NormalizeMethod } from '@/types/score'
import { defaultReviewValidDays } from '@/types/score'
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
import { reviewStatusOf } from '@/utils/review'
import { todayIso } from '@/utils/format'

export interface RankingInput {
  /** 参与排名的营位集合 */
  sites: () => Campsite[]
  /** siteId -> 用于评分的因子记录（通常取最新一轮评估） */
  factorOf: (siteId: number) => FactorAssessment | null
  weights: () => FactorWeights
  normalize: () => NormalizeMethod
  thresholds: () => GradeThresholds
  /** 命中否决项的营位 id 集合 */
  vetoedIds: () => number[]
  /** 复评时效（天）；缺省按旱季默认口径 30 天 */
  reviewValidDays?: () => number
  /** 当前日期（YYYY-MM-DD），默认今天；便于测试与对齐展示口径 */
  today?: () => string
}

export interface RankingRow extends SiteScore {
  site: Campsite
  rank: number
  raw: RawFactorValues
  vetoTypes: string[]
}

/** 超期未复评的营位：退出本批比较，等待补录新一轮实测 */
export interface StaleRow {
  site: Campsite
  siteId: number
  /** 最新一轮实测日期；从未评估时为 null */
  assessedAt: string | null
  /** 已超期天数；从未评估时为 0 */
  overdueDays: number
  /** 采用的时效天数 */
  validDays: number
  vetoed: boolean
}

export interface RankingState {
  /** 已按得分降序排列的名次（仅含时效内的营位） */
  ranked: ComputedRef<RankingRow[]>
  /** 超期未复评、退出本批比较的营位 */
  stale: ComputedRef<StaleRow[]>
  scoreOf: (siteId: number) => RankingRow | null
  gradeOfSite: (siteId: number) => Grade
  /** 该营位是否超期待复评 */
  isStale: (siteId: number) => boolean
  best: ComputedRef<RankingRow | null>
}

export function useRanking(input: RankingInput): RankingState {
  const scope = effectScope(true)

  /** 时效内营位 + 超期营位的分流，名次与待复评列表共用同一份判定 */
  const partitioned = scope.run(() =>
    computed(() => {
      const sites = input.sites() ?? []
      const normalize = input.normalize()
      const weights = input.weights()
      const thresholds = input.thresholds()
      const vetoSet = new Set(input.vetoedIds() ?? [])
      const validDays = input.reviewValidDays?.() ?? defaultReviewValidDays('四季通用')
      const today = input.today?.() ?? todayIso()

      const list = sites.filter((s): s is Campsite & { id: number } => typeof s.id === 'number')

      // 先按时效分流：超期营位退出本批比较，不再参与归一化
      const fresh: Array<{ site: Campsite & { id: number }; factor: FactorAssessment | null }> = []
      const staleRows: StaleRow[] = []
      for (const site of list) {
        const factor = input.factorOf(site.id)
        const status = reviewStatusOf(factor, validDays, today)
        if (status.expired) {
          staleRows.push({
            site,
            siteId: site.id,
            assessedAt: status.assessedAt,
            overdueDays: status.overdueDays,
            validDays: status.validDays,
            vetoed: vetoSet.has(site.id)
          })
        } else {
          fresh.push({ site, factor })
        }
      }

      // 关键：极差归一必须**同批营位一起比较**，逐条归一的话单条样本跨度为零会全部得 100。
      // 因此先收集全部原始指标，一次性归一化，再回填到每个营位。
      // 超期营位已退出，这里只对时效内的营位按同一口径归一。
      const entries = fresh.map(({ site, factor }) => ({
        siteId: site.id,
        values: rawValuesOf(site, factor)
      }))
      const matrix = buildNormalizedMatrix(entries, normalize)

      const rows: RankingRow[] = fresh.map(({ site }, idx) => {
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
          rank: 0
        } satisfies RankingRow
      })

      const sorted = rows.sort((a, b) => b.total - a.total)
      sorted.forEach((row, idx) => {
        row.rank = idx + 1
      })
      return { ranked: sorted, stale: staleRows }
    })
  ) as ComputedRef<{ ranked: RankingRow[]; stale: StaleRow[] }>

  const ranked = computed(() => partitioned.value.ranked)
  const stale = computed(() => partitioned.value.stale)

  function scoreOf(siteId: number): RankingRow | null {
    return ranked.value.find((r) => r.siteId === siteId) ?? null
  }

  function gradeOfSite(siteId: number): Grade {
    return scoreOf(siteId)?.grade ?? 'C'
  }

  function isStale(siteId: number): boolean {
    return stale.value.some((r) => r.siteId === siteId)
  }

  const best = computed<RankingRow | null>(() => ranked.value[0] ?? null)

  return {
    ranked,
    stale,
    scoreOf,
    gradeOfSite,
    isStale,
    best
  }
}
