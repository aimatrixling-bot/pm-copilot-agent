---
id: nav-stepper
category: navigation
tags: [stepper, steps, wizard, progress]
complexity: intermediate
---

# 步骤条

## 适用场景
- 多步表单
- 引导流程
- 进度展示

## 代码示例

```html
<div class="flex items-center">
  <!-- Step 1: Completed -->
  <div class="flex items-center">
    <div class="w-8 h-8 rounded-full bg-blue-600 text-white
                flex items-center justify-center text-sm font-medium">
      <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
        <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1
          1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1
          0 011.414 0z" clip-rule="evenodd"/>
      </svg>
    </div>
    <span class="ml-2 text-sm font-medium text-blue-600">Account</span>
  </div>
  <!-- Connector -->
  <div class="flex-1 h-0.5 bg-blue-600 mx-4"></div>
  <!-- Step 2: Current -->
  <div class="flex items-center">
    <div class="w-8 h-8 rounded-full bg-blue-600 text-white
                flex items-center justify-center text-sm font-medium">2</div>
    <span class="ml-2 text-sm font-medium text-blue-600">Profile</span>
  </div>
  <!-- Connector -->
  <div class="flex-1 h-0.5 bg-gray-200 mx-4"></div>
  <!-- Step 3: Pending -->
  <div class="flex items-center">
    <div class="w-8 h-8 rounded-full border-2 border-gray-300 text-gray-400
                flex items-center justify-center text-sm">3</div>
    <span class="ml-2 text-sm text-gray-400">Review</span>
  </div>
</div>
```

## 变体
- **水平**：左到右排列（桌面端）
- **垂直**：上到下排列（移动端）
- **简洁**：仅圆点 + 连线
- **带描述**：标题 + 描述文字

## 注意事项
- 步骤 ≤ 7 个，超出拆分为子步骤
- 每步标题简短（1-2 个词）
- 三种状态：已完成(打勾)、当前(高亮)、待完成(灰色)
- 允许回退到已完成步骤
