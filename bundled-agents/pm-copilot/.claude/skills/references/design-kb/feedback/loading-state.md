---
id: feedback-loading
category: feedback
tags: [loading, spinner, skeleton, progress]
complexity: basic
---

# 加载状态

## 适用场景
- 数据加载中
- 页面切换
- 异步操作等待

## 代码示例

```html
<!-- Spinner -->
<div class="flex items-center justify-center py-8">
  <div class="w-8 h-8 border-4 border-gray-200 border-t-blue-600
              rounded-full animate-spin"></div>
</div>

<!-- Skeleton -->
<div class="animate-pulse space-y-4">
  <div class="h-4 bg-gray-200 rounded w-3/4"></div>
  <div class="h-4 bg-gray-200 rounded w-1/2"></div>
  <div class="h-32 bg-gray-200 rounded"></div>
</div>

<!-- Progress Bar -->
<div class="w-full bg-gray-200 rounded-full h-2">
  <div class="bg-blue-600 h-2 rounded-full" style="width: 65%"></div>
</div>
```

## 变体
- **Spinner**：通用旋转指示器
- **Skeleton**：内容占位符（推荐）
- **进度条**：可量化的进度
- **全屏**：页面级加载

## 注意事项
- < 1 秒的操作用 spinner
- > 1 秒的操作用进度条或 skeleton
- Skeleton 形状与实际内容匹配
- 避免页面跳动（skeleton 尺寸与内容一致）
