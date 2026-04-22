---
id: layout-sidebar
category: layouts
tags: [sidebar, dashboard, admin]
complexity: basic
---

# 侧栏布局

## 适用场景
- 后台管理系统
- Dashboard
- 设置页面

## 代码示例

```html
<div class="flex h-screen">
  <!-- Sidebar -->
  <aside class="w-60 bg-gray-900 text-white flex-shrink-0">
    <div class="p-4 text-lg font-bold">App Name</div>
    <nav class="mt-4">
      <a href="#" class="block px-4 py-2 hover:bg-gray-800">Dashboard</a>
      <a href="#" class="block px-4 py-2 bg-gray-800">Users</a>
      <a href="#" class="block px-4 py-2 hover:bg-gray-800">Settings</a>
    </nav>
  </aside>
  <!-- Main Content -->
  <main class="flex-1 overflow-auto bg-gray-50 p-6">
    <h1 class="text-2xl font-bold mb-4">Page Title</h1>
  </main>
</div>
```

## 变体
- **固定侧栏**：始终可见，宽度不变
- **可折叠侧栏**：点击按钮收起/展开，收起时仅显示图标
- **响应式侧栏**：桌面固定，移动端抽屉式

## 注意事项
- 侧栏宽度 240-280px
- 移动端默认隐藏，通过 hamburger menu 触发
- 侧栏项使用 hover + active 状态区分
