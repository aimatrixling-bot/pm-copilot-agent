---
id: nav-tabs
category: navigation
tags: [tabs, tabbed, panel, sections]
complexity: basic
---

# 标签页

## 适用场景
- 内容分组展示
- 设置面板分区
- 详情页信息分区

## 代码示例

```html
<div>
  <!-- Tab Headers -->
  <div class="border-b flex gap-4">
    <button class="px-4 py-2 text-sm border-b-2 border-blue-600 text-blue-600 font-medium">
      Overview
    </button>
    <button class="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">
      Analytics
    </button>
    <button class="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">
      Settings
    </button>
  </div>
  <!-- Tab Content -->
  <div class="py-4">
    <p>Tab content here</p>
  </div>
</div>
```

## 变体
- **水平**：顶部分栏（最常见）
- **垂直**：侧栏标签（设置页面）
- **胶囊**：圆角背景高亮
- **下划线**：底部线条高亮

## 注意事项
- 标签数量 ≤ 7 个，超出用 "More" 下拉
- 标签文字简短（1-2 个词）
- 当前标签用颜色 + 下划线/背景区分
- 切换时内容区平滑过渡
