---
id: feedback-alert
category: feedback
tags: [alert, banner, warning, notice]
complexity: basic
---

# 警告横幅

## 适用场景
- 系统公告
- 操作警告
- 重要提示
- 维护通知

## 代码示例

```html
<!-- Warning Banner -->
<div class="bg-yellow-50 border-l-4 border-yellow-400 p-4">
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-3">
      <svg class="w-5 h-5 text-yellow-600 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
        <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486
          0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11
          13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1
          1 0 00-1-1z" clip-rule="evenodd"/>
      </svg>
      <p class="text-sm text-yellow-700">Scheduled maintenance on April 15, 2:00-4:00 AM UTC</p>
    </div>
    <button class="text-yellow-600 hover:text-yellow-800">Dismiss</button>
  </div>
</div>
```

## 变体
- **成功**：绿色 `bg-green-50 border-green-400`
- **警告**：黄色 `bg-yellow-50 border-yellow-400`
- **错误**：红色 `bg-red-50 border-red-400`
- **信息**：蓝色 `bg-blue-50 border-blue-400`

## 注意事项
- 位置固定（顶部），不影响内容阅读
- 可关闭（Dismiss 按钮）
- 紧急程度越高，颜色越醒目
- 多个 banner 堆叠显示
