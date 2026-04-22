---
id: display-detail
category: data-display
tags: [detail, panel, drawer, info]
complexity: intermediate
---

# 详情面板

## 适用场景
- 数据详情查看
- 用户信息展示
- 订单详情

## 代码示例

```html
<!-- Slide-over Panel -->
<div class="fixed inset-y-0 right-0 w-96 bg-white shadow-xl z-20">
  <div class="flex items-center justify-between p-4 border-b">
    <h2 class="text-lg font-bold">Details</h2>
    <button class="text-gray-400 hover:text-gray-600">Close</button>
  </div>
  <div class="p-4 space-y-4">
    <div>
      <dt class="text-sm text-gray-500">Name</dt>
      <dd class="text-sm font-medium">John Doe</dd>
    </div>
    <div>
      <dt class="text-sm text-gray-500">Email</dt>
      <dd class="text-sm font-medium">john@example.com</dd>
    </div>
  </div>
  <div class="absolute bottom-0 left-0 right-0 p-4 border-t bg-white">
    <button class="w-full bg-blue-600 text-white py-2 rounded">Edit</button>
  </div>
</div>
```

## 变体
- **侧滑面板**：从右侧滑入
- **模态**：居中弹窗
- **内联展开**：表格行展开
- **独立页面**：整页详情

## 注意事项
- 关键信息放上方
- 操作按钮固定在底部
- 支持键盘 ESC 关闭
- 遮罩层点击关闭
