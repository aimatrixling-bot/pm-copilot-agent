---
id: nav-breadcrumb
category: navigation
tags: [breadcrumb, path, hierarchy]
complexity: basic
---

# 面包屑导航

## 适用场景
- 层级页面导航
- 目录结构浏览
- 步骤流程回溯

## 代码示例

```html
<nav class="flex items-center text-sm text-gray-500">
  <a href="#" class="hover:text-gray-700">Home</a>
  <span class="mx-2">/</span>
  <a href="#" class="hover:text-gray-700">Products</a>
  <span class="mx-2">/</span>
  <span class="text-gray-900 font-medium">Current Page</span>
</nav>
```

## 变体
- **基本**：文字 + 分隔符（`/` 或 `>`）
- **带图标**：分隔符用 chevron 图标
- **带下拉**：中间层级可展开子项

## 注意事项
- 最后一项不可点击，用不同样式区分
- 层级不宜超过 4 级
- 移动端可简化为 "Back" 按钮
- 使用 `<nav>` + `aria-label="Breadcrumb"` 保证无障碍
