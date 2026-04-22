---
id: form-checkbox-radio
category: forms
tags: [checkbox, radio, toggle, multi-select]
complexity: basic
---

# 复选框和单选按钮

## 适用场景
- 多选项（Checkbox）
- 互斥选择（Radio）
- 协议确认
- 筛选条件

## 代码示例

```html
<!-- Checkbox -->
<label class="flex items-center gap-2 cursor-pointer">
  <input type="checkbox" class="w-4 h-4 rounded border-gray-300
                                 text-blue-600 focus:ring-blue-500">
  <span class="text-sm text-gray-700">Remember me</span>
</label>

<!-- Radio Group -->
<fieldset class="space-y-2">
  <legend class="text-sm font-medium text-gray-700">Plan</legend>
  <label class="flex items-center gap-2 cursor-pointer">
    <input type="radio" name="plan" value="free" checked
      class="w-4 h-4 border-gray-300 text-blue-600 focus:ring-blue-500">
    <span class="text-sm">Free</span>
  </label>
  <label class="flex items-center gap-2 cursor-pointer">
    <input type="radio" name="plan" value="pro"
      class="w-4 h-4 border-gray-300 text-blue-600 focus:ring-blue-500">
    <span class="text-sm">Pro</span>
  </label>
</fieldset>
```

## 变体
- **标准**：原生 checkbox/radio
- **卡片式**：整个卡片可点击，选中高亮
- **开关式**：Toggle switch（用于设置项）

## 注意事项
- Radio 互斥，同一组 `name` 相同
- Checkbox 可多选
- 点击文字也能选中（`<label>` 包裹）
- 默认选中项用 `checked`
