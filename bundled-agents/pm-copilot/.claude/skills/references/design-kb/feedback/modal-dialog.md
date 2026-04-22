---
id: feedback-modal
category: feedback
tags: [modal, dialog, confirm, overlay]
complexity: intermediate
---

# 模态对话框

## 适用场景
- 确认删除等危险操作
- 表单填写（不跳转页面）
- 重要信息展示

## 代码示例

```html
<!-- Overlay -->
<div class="fixed inset-0 bg-black/50 z-40 flex items-center justify-center">
  <!-- Dialog -->
  <div class="bg-white rounded-lg shadow-xl w-full max-w-md mx-4 z-50">
    <div class="p-6">
      <h3 class="text-lg font-bold text-gray-900">Confirm Delete</h3>
      <p class="mt-2 text-sm text-gray-600">
        Are you sure? This action cannot be undone.
      </p>
    </div>
    <div class="flex justify-end gap-3 px-6 py-4 bg-gray-50 rounded-b-lg">
      <button class="px-4 py-2 text-sm text-gray-700 border rounded">Cancel</button>
      <button class="px-4 py-2 text-sm text-white bg-red-600 rounded">Delete</button>
    </div>
  </div>
</div>
```

## 变体
- **确认**：标题 + 描述 + 取消/确认
- **表单**：弹窗内含表单
- **信息**：只读内容展示
- **全屏**：大面积内容（移动端常见）

## 注意事项
- ESC 键可关闭
- 点击遮罩关闭（可选）
- 焦点陷阱（Tab 不跳出对话框）
- 确认按钮用危险色（红色）表示破坏性操作
