---
id: display-empty-state
category: data-display
tags: [empty, placeholder, onboarding]
complexity: basic
---

# 空状态

## 适用场景
- 无数据
- 搜索无结果
- 首次使用引导

## 代码示例

```html
<div class="flex flex-col items-center justify-center py-12 text-center">
  <div class="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4">
    <svg class="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
        d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"/>
    </svg>
  </div>
  <h3 class="text-lg font-medium text-gray-900">No items yet</h3>
  <p class="text-sm text-gray-500 mt-1 max-w-sm">Get started by creating your first item.</p>
  <button class="mt-4 bg-blue-600 text-white px-4 py-2 rounded text-sm">Create Item</button>
</div>
```

## 变体
- **无数据**：插图 + 创建按钮
- **搜索无结果**：提示调整搜索词
- **错误状态**：重试按钮
- **首次使用**：引导说明

## 注意事项
- 提供明确的下一步操作（CTA 按钮）
- 插图/图标增强视觉
- 说明文字简洁（1-2 句）
- 保持与品牌一致的视觉风格
