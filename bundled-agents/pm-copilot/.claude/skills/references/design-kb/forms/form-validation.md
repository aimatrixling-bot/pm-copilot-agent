---
id: form-validation
category: forms
tags: [validation, error, feedback, success]
complexity: intermediate
---

# 表单验证

## 适用场景
- 所有表单输入的验证反馈

## 代码示例

```html
<!-- Error State -->
<div class="mb-4">
  <label class="block text-sm font-medium text-red-700 mb-1">Email</label>
  <input type="email"
    class="w-full px-3 py-2 border-2 border-red-500 rounded-md
           focus:ring-2 focus:ring-red-500"
    value="invalid-email">
  <p class="mt-1 text-sm text-red-600">Please enter a valid email address</p>
</div>

<!-- Success State -->
<div class="mb-4">
  <label class="block text-sm font-medium text-green-700 mb-1">Email</label>
  <input type="email"
    class="w-full px-3 py-2 border-2 border-green-500 rounded-md
           focus:ring-2 focus:ring-green-500"
    value="user@example.com">
  <p class="mt-1 text-sm text-green-600">Looks good!</p>
</div>
```

## 变体
- **行内验证**：输入时实时验证
- **提交验证**：表单提交时批量验证
- **实时验证**：失焦后验证（推荐）

## 注意事项
- 错误消息具体明确（"请输入有效邮箱" 而非 "格式错误"）
- 成功消息简洁（"OK" 或打勾图标）
- 验证时机：失焦后 > 输入时 > 提交时
- 颜色：错误红(red-500)、成功绿(green-500)、警告黄(yellow-500)
