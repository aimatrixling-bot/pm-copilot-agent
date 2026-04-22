---
id: form-select
category: forms
tags: [select, dropdown, option]
complexity: basic
---

# 下拉选择

## 适用场景
- 分类选择
- 状态选择
- 设置项选择

## 代码示例

```html
<div class="mb-4">
  <label class="block text-sm font-medium text-gray-700 mb-1">
    Category
  </label>
  <select class="w-full px-3 py-2 border border-gray-300 rounded-md
                 bg-white focus:ring-2 focus:ring-blue-500">
    <option value="">Select a category...</option>
    <option value="tech">Technology</option>
    <option value="design">Design</option>
    <option value="product">Product</option>
  </select>
</div>
```

## 变体
- **单选**：标准 `<select>`
- **多选**：`<select multiple>` 或 checkbox 列表
- **可搜索**：带搜索框的下拉（需要 JS 组件）
- **分组**：`<optgroup>` 分组选项

## 注意事项
- 选项 ≤ 7 个时考虑用 Radio 按钮
- 选项 > 20 个时添加搜索
- 第一项用占位文本（"请选择..."）
- `bg-white` 确保样式覆盖浏览器默认
