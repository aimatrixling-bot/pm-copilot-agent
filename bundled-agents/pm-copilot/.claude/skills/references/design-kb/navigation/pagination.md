---
id: nav-pagination
category: navigation
tags: [pagination, pager, pages]
complexity: basic
---

# 分页

## 适用场景
- 列表翻页
- 搜索结果
- 数据浏览

## 代码示例

```html
<div class="flex items-center justify-between py-4">
  <span class="text-sm text-gray-500">Showing 1-10 of 48</span>
  <div class="flex items-center gap-1">
    <button class="px-3 py-1 text-sm border rounded hover:bg-gray-50 disabled:opacity-50"
      disabled>Prev</button>
    <button class="px-3 py-1 text-sm border rounded bg-blue-600 text-white">1</button>
    <button class="px-3 py-1 text-sm border rounded hover:bg-gray-50">2</button>
    <button class="px-3 py-1 text-sm border rounded hover:bg-gray-50">3</button>
    <span class="px-2 text-gray-400">...</span>
    <button class="px-3 py-1 text-sm border rounded hover:bg-gray-50">5</button>
    <button class="px-3 py-1 text-sm border rounded hover:bg-gray-50">Next</button>
  </div>
</div>
```

## 变体
- **基本**：页码 + 上一页/下一页
- **紧凑**：仅 上一页/下一页
- **无限滚动**：滚动自动加载
- **加载更多**：底部按钮

## 注意事项
- 显示总数和当前范围
- 当前页高亮，其他页可点击
- 页码 > 5 时用省略号
- 第一页禁用 Prev，最后一页禁用 Next
