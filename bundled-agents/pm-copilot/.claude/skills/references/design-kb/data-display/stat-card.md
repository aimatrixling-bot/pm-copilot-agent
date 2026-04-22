---
id: display-stat-card
category: data-display
tags: [stat, metric, KPI, dashboard]
complexity: basic
---

# 统计卡片

## 适用场景
- Dashboard 数据概览
- KPI 展示
- 关键指标

## 代码示例

```html
<div class="bg-white rounded-lg shadow p-6">
  <div class="flex items-center justify-between mb-2">
    <span class="text-sm font-medium text-gray-600">Total Users</span>
    <span class="text-green-600 text-xs font-medium">+12.5%</span>
  </div>
  <div class="text-3xl font-bold text-gray-900">24,512</div>
  <p class="text-xs text-gray-500 mt-1">vs 21,790 last month</p>
</div>
```

## 变体
- **简单**：数值 + 标签
- **带趋势**：+/- 变化百分比
- **带图表**：迷你折线图/柱状图
- **带进度**：进度条 + 目标值

## 注意事项
- 数值右对齐或底部对齐（多卡片排列时）
- 变化用颜色区分：绿=增长，红=下降
- 数值格式化：千位逗号、单位（K/M）
- 卡片间用 grid 排列（`grid-cols-2 lg:grid-cols-4`）
