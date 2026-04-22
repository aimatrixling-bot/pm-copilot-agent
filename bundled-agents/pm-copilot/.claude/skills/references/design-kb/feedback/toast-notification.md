---
id: feedback-toast
category: feedback
tags: [toast, notification, alert, message]
complexity: basic
---

# 提示通知

## 适用场景
- 操作成功/失败反馈
- 系统通知
- 确认消息

## 代码示例

```html
<!-- Success Toast -->
<div class="fixed top-4 right-4 z-50 bg-green-600 text-white px-4 py-3
            rounded-lg shadow-lg flex items-center gap-2
            animate-[slideIn_0.3s_ease-out]">
  <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8
      8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1
      1 0 011.414 0z" clip-rule="evenodd"/>
  </svg>
  <span class="text-sm">Saved successfully</span>
  <button class="ml-2 hover:opacity-70">x</button>
</div>

<style>
@keyframes slideIn { from { transform: translateX(100%); opacity: 0; } }
</style>
```

## 变体
- **成功**：绿色，打勾图标
- **错误**：红色，警告图标
- **警告**：黄色，三角图标
- **信息**：蓝色，圆圈图标

## 注意事项
- 3-5 秒自动消失
- 可手动关闭
- 堆叠显示（最新在最上方）
- 不阻断用户操作
