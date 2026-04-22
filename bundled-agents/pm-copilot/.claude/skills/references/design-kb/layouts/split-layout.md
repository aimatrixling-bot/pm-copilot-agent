---
id: layout-split
category: layouts
tags: [split, auth, onboarding, comparison]
complexity: basic
---

# 分栏布局

## 适用场景
- 登录/注册页面
- 功能对比
- 步骤引导
- 营销落地页

## 代码示例

```html
<div class="min-h-screen grid grid-cols-1 lg:grid-cols-2">
  <!-- Left Panel -->
  <div class="bg-gray-900 text-white flex items-center justify-center p-12">
    <div>
      <h1 class="text-4xl font-bold">Welcome Back</h1>
      <p class="mt-4 text-gray-300">Sign in to continue</p>
    </div>
  </div>
  <!-- Right Panel -->
  <div class="flex items-center justify-center p-12">
    <form class="w-full max-w-sm">
      <h2 class="text-2xl font-bold mb-6">Sign In</h2>
      <!-- Form fields -->
    </form>
  </div>
</div>
```

## 变体
- **50/50**：等分
- **60/40**：主/次分区
- **40/60**：次/主分区
- **叠加**：一侧覆盖在另一侧上（移动端）

## 注意事项
- 移动端堆叠为单列
- 主内容区放表单/操作，次要区放插图/信息
- 两栏可以有不同的背景色
