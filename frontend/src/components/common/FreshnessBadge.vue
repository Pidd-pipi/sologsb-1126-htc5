<script setup lang="ts">
/**
 * FreshnessBadge —— 营位最新一轮现场实测的复评时效徽标。
 * 在比营位显示「复评有效 · 还剩 N 天」（临期给警示色）；
 * 超期未复评显示红色「待复评 · 已超 N 天」，该营位此时已退出本批比较。
 */
import { computed } from 'vue'
import type { FreshnessResult } from '@/utils/freshness'

const props = withDefaults(
  defineProps<{
    freshness: FreshnessResult
    /** 方案复评时效天数，用于在 tooltip 中展示完整口径 */
    reviewDays?: number
    /** 是否只展示简短标签（表格窄列用） */
    inline?: boolean
  }>(),
  {
    reviewDays: undefined,
    inline: false
  }
)

type TagType = 'success' | 'warning' | 'danger' | 'info'

const ui = computed<{ type: TagType; text: string; title: string }>(() => {
  const f = props.freshness
  if (f.neverAssessed) {
    return {
      type: 'info',
      text: '暂无实测',
      title: '该营位还没有现场实测记录，评分暂用保守缺省值。'
    }
  }
  if (f.overdue) {
    // daysLeft = 时效 - 已过天数，超期时为负数，取反即「已超几天」。
    const overdue = f.daysLeft != null ? Math.max(0, -f.daysLeft) : 0
    return {
      type: 'danger',
      text: props.inline ? `待复评${overdue > 0 ? ` · 超 ${overdue} 天` : ''}` : `待复评 · 已超 ${overdue} 天`,
      title: `最新实测 ${f.assessedAt}，已退出本批比较；补录新一轮实测后立即回到名次。`
    }
  }
  const left = f.daysLeft ?? 0
  // 剩余 ≤ 3 天视为临期，提醒尽快安排复评。
  const type: TagType = left <= 3 ? 'warning' : 'success'
  return {
    type,
    text: props.inline ? `剩 ${left} 天` : `复评有效 · 还剩 ${left} 天`,
    title: `最新实测 ${f.assessedAt}，应在 ${f.dueAt ?? '—'} 前复评（时效 ${props.reviewDays ?? '—'} 天）。`
  }
})
</script>

<template>
  <el-tooltip :content="ui.title" placement="top">
    <el-tag :type="ui.type" size="small" effect="plain" class="freshness-tag">
      <span v-if="!inline && ui.type === 'danger'" class="freshness-tag__dot" />
      {{ ui.text }}
    </el-tag>
  </el-tooltip>
</template>

<style scoped>
.freshness-tag {
  white-space: nowrap;
}
.freshness-tag__dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  margin-right: 4px;
  animation: freshness-blink 1.4s ease-in-out infinite;
}
@keyframes freshness-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}
</style>
