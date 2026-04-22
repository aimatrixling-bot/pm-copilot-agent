---
id: display-table
category: data-display
tags: [table, data, list, sortable]
complexity: intermediate
---

# 数据表格

## 适用场景
- 数据管理界面
- 列表展示
- 报表

## 代码示例

```html
<div class="overflow-x-auto">
  <table class="w-full text-left">
    <thead class="bg-gray-50 border-b">
      <tr>
        <th class="px-4 py-3 text-sm font-medium text-gray-600">Name</th>
        <th class="px-4 py-3 text-sm font-medium text-gray-600">Status</th>
        <th class="px-4 py-3 text-sm font-medium text-gray-600">Date</th>
      </tr>
    </thead>
    <tbody class="divide-y">
      <tr class="hover:bg-gray-50">
        <td class="px-4 py-3">Item 1</td>
        <td class="px-4 py-3"><span class="px-2 py-1 bg-green-100 text-green-800 rounded text-xs">Active</span></td>
        <td class="px-4 py-3 text-gray-500">2026-04-10</td>
      </tr>
    </tbody>
  </table>
</div>
```

## 变体
- **基本**：静态展示
- **可排序**：点击表头排序
- **分页**：底部分页控件
- **行选择**：左侧 checkbox

## 注意事项
- 移动端横向滚动（`overflow-x-auto`）
- 斑马纹帮助视觉追踪（`divide-y`）
- 空状态用 `colspan` 全宽提示
