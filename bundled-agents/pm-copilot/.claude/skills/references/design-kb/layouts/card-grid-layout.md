---
id: layout-card-grid
category: layouts
tags: [cards, grid, gallery, products]
complexity: basic
---

# 卡片网格布局

## 适用场景
- 产品列表
- 仪表板小组件
- 内容展示（文章、项目）

## 代码示例

```html
<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
  <div class="bg-white rounded-lg shadow overflow-hidden">
    <img src="placeholder.jpg" class="w-full h-48 object-cover" alt="">
    <div class="p-4">
      <h3 class="font-bold text-lg">Card Title</h3>
      <p class="text-gray-600 mt-1 text-sm">Card description text</p>
    </div>
  </div>
  <!-- Repeat cards -->
</div>
```

## 变体
- **2 列**：`grid-cols-2`，适合宽卡片
- **3 列**：`grid-cols-3`，标准布局
- **4 列**：`grid-cols-4`，适合缩略图
- **自适应**：`auto-fill minmax(280px, 1fr)`

## 注意事项
- 卡片间距统一 16-24px（`gap-4` 或 `gap-6`）
- 图片比例一致（`aspect-video` 或固定高度）
- 卡片内容对齐（标题、描述、按钮）
