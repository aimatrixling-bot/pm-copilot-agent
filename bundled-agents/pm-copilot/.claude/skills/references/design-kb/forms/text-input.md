---
id: form-text-input
category: forms
tags: [input, text, email, password]
complexity: basic
---

# 文本输入

## 适用场景
- 登录、注册表单
- 搜索框
- 通用数据录入

## 代码示例

```html
<div class="mb-4">
  <label class="block text-sm font-medium text-gray-700 mb-1">
    Email
  </label>
  <input type="email"
    class="w-full px-3 py-2 border border-gray-300 rounded-md
           focus:ring-2 focus:ring-blue-500 focus:border-blue-500
           placeholder:text-gray-400"
    placeholder="you@example.com">
  <p class="mt-1 text-sm text-red-600 hidden">Please enter a valid email</p>
</div>
```

## 变体
- **单行**：`<input>`，通用文本
- **多行**：`<textarea>`，长文本
- **带图标**：左侧/右侧图标（搜索、清除）
- **带前缀**：货币符号、国家代码

## 注意事项
- Label 始终可见，不用 placeholder 替代
- 错误状态用红色边框 + 错误文本
- Focus 状态明显（ring + border 变色）
- 禁用状态用 `opacity-50 cursor-not-allowed`
