---
id: layout-topnav
category: layouts
tags: [topnav, landing, marketing]
complexity: basic
---

# 顶部导航布局

## 适用场景
- 官网、落地页
- 博客
- 营销页面

## 代码示例

```html
<div class="min-h-screen flex flex-col">
  <!-- Top Nav -->
  <header class="bg-white border-b sticky top-0 z-10">
    <div class="max-w-7xl mx-auto flex items-center justify-between h-16 px-4">
      <span class="text-xl font-bold">Brand</span>
      <nav class="hidden md:flex gap-6">
        <a href="#" class="text-gray-600 hover:text-gray-900">Features</a>
        <a href="#" class="text-gray-600 hover:text-gray-900">Pricing</a>
        <a href="#" class="text-gray-600 hover:text-gray-900">About</a>
      </nav>
      <button class="md:hidden">Menu</button>
    </div>
  </header>
  <!-- Content -->
  <main class="flex-1">
    <div class="max-w-7xl mx-auto px-4 py-8">Content here</div>
  </main>
</div>
```

## 变体
- **透明顶栏**：背景透明，滚动后变白
- **固定顶栏**：始终可见，不随页面滚动
- **滚动隐藏**：向下滚动隐藏，向上滚动显示

## 注意事项
- 移动端使用 hamburger menu
- 导航项 ≤ 7 个，超出使用 "More" 下拉
- 高度通常 56-64px
