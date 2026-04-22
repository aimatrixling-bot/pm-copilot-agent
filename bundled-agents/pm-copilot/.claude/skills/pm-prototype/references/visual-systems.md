# 视觉系统参考

> **原型设计的视觉美学指南 — 定义差异化视觉方向**

---

## 美学基调矩阵

### 基调选择

**原则**: 选择一个基调并坚持执行。**不要混合**。

| 基调 | 描述 | 适用场景 | 特征 |
| --- | --- | --- | --- |
| **Editorial Authority** | 杂志风格，强排版，非对称 | 内容平台，媒体，出版 | 大标题，断点对齐，高对比 |
| **Brutalist Raw** | 原始，暴露结构，粗对比 | 开发者工具，技术产品 | 单色，等宽，代码风格 |
| **Luxury Minimal** | 精致优雅，慷慨留白 | 高端品牌，奢侈品 | 细线，轻量，精细 |
| **Industrial Utility** | 功能性，数据密集 | B2B 工具，企业软件 | 密集，结构化，实用 |
| **Retro-Futuristic** | 怀旧但向前，霓虹强调 | 科技产品，Web3，游戏 | 深色，霓虹，网格 |
| **Organic Natural** | 柔和，流动，大地色 | 健康，环保，生活 | 曲线，自然，柔和 |
| **Playful Modular** | 色彩，块状，交互 | 教育，创意，儿童 | 鲜艳，圆润，动态 |
| **Precision Enterprise** | 干净，系统化 | 企业软件，金融 | 系统，一致，专业 |
| **Experimental Maximal** | 大胆，分层，表达 | 创意，艺术，时尚 | 复杂，丰富，视觉 |

---

## 字体系统

### 避免 AI 默认

❌ **过度使用的字体**:
- Inter
- Roboto
- Open Sans
- SF Pro (Apple 系统字体)

✅ **选择独特字体**:
- ** serif**: Georgia, Playfair Display, Source Serif
- **sans-serif**: Work Sans, Space Grotesk, Satoshi
- **display**: Chronique Display, Caslon, Abril Fatface
- **mono**: JetBrains Mono, IBM Plex Mono, Fira Code

### 字体配对

| 层级 | 展示字体 | 正文字体 | 代码字体 |
| --- | --- | --- | --- |
| **Serif Classic** | Playfair Display | Georgia | JetBrains Mono |
| **Sans Modern** | Space Grotesk | Work Sans | IBM Plex Mono |
| **Tech Bold** | Syncopate | Source Sans 3 | Fira Code |
| **Editorial** | Abril Fatface | Source Serif | JetBrains Mono |

### 字体比例

```
展示字体: H1, H2
正文字体: Body, H3, H4
代码字体: Code, Data

大小比例:
H1: 48-72px (6rem)
H2: 36-48px (3-4rem)
H3: 24-30px (1.5-2rem)
Body: 16-18px (1rem)
Small: 14px (0.875rem)
```

---

## 颜色系统

### 主题定义

```css
:root {
  /* Base - 基础色 */
  --color-base: #0f172a;
  --color-base-invert: #f8fafc;

  /* Text - 文本色 */
  --color-text-primary: #0f172a;
  --color-text-secondary: #475569;
  --color-text-tertiary: #94a3b8;

  /* Primary - 主色 */
  --color-primary: #3b82f6;
  --color-primary-dark: #2563eb;
  --color-primary-light: #60a5fa;

  /* Semantic - 语义色 */
  --color-success: #10b981;
  --color-warning: #f59e0b;
  --color-error: #ef4444;
  --color-info: #3b82f6;

  /* Surface - 表面色 */
  --color-surface: #ffffff;
  --color-surface-alt: #f8fafc;
  --color-surface-elevated: #f1f5f9;

  /* Border - 边框色 */
  --color-border: #e2e8f0;
  --color-border-strong: #cbd5e1;
}
```

### WCAG AA 对比要求

| 组合 | 最小对比度 | 示例 |
| --- | --- | --- |
| 正常文字 | 4.5:1 | #000000 on #FFFFFF (21:1) |
| 大文字 (18pt+) | 3:1 | #333333 on #FFFFFF (12.6:1) |
| 图标/图形 | 3:1 | 同上 |

---

## 间距系统

### 8pt 网格系统

```css
--space-1: 4px;   /* 0.25rem */
--space-2: 8px;   /* 0.5rem */
--space-3: 12px;  /* 0.75rem */
--space-4: 16px;  /* 1rem */
--space-5: 20px;  /* 1.25rem */
--space-6: 24px;  /* 1.5rem */
--space-8: 32px;  /* 2rem */
--space-10: 40px; /* 2.5rem */
--space-12: 48px; /* 3rem */
--space-16: 64px; /* 4rem */
```

### 组件内间距

| 组件类型 | padding | margin |
| --- | --- | --- |
| 按钮 | 12px 24px | 8px |
| 输入框 | 12px 16px | 8px |
| 卡片 | 24px | 16px |
| 容器 | 24px | 0 |

---

## 组件规范

### 按钮系统

| 类型 | 样式 | 用途 |
| --- | --- | --- |
| **Primary** | 主色填充，白色文字 | 主要行动 |
| **Secondary** | 轮廓，主色边框 | 次要行动 |
| **Ghost** | 透明，主色文字 | 低优先级行动 |
| **Destructive** | 红色填充，白色文字 | 危险操作 |

### 表单系统

| 状态 | 边框 | 背景 | 文字 |
| --- | --- | --- | --- |
| 默认 | #E2E8F0 | #FFFFFF | #0F172A |
| 聚焦 | #3B82F6 | #EFF6FF | #0F172A |
| 错误 | #EF4444 | #FEF2F2 | #991B1B |
| 禁用 | #F1F5F9 | #F8FAFC | #94A3B8 |

---

## 动画和过渡

### 原则

- **有目的**: 只动画有意义的交互
- **快速**: 200-300ms 过渡
- **缓动**: ease-out 或 ease-in-out

```css
--duration-fast: 150ms;
--duration-base: 200ms;
--duration-slow: 300ms;

--easing: cubic-bezier(0.4, 0, 0.2, 1);
```

---

## 图标系统

### 推荐

- **Heroicons** (一致性强)
- **Phosphor** (风格多样)
- **Lucide** (现代简洁)

### 规格

- 尺寸: 16px, 20px, 24px
- 描边: 1.5px
- 圆角: 随设计系统

---

## 深色模式

```css
[data-theme="dark"] {
  --color-base: #f8fafc;
  --color-base-invert: #0f172a;
  --color-text-primary: #f8fafc;
  --color-text-secondary: #cbd5e1;
  --color-surface: #1e293b;
  --color-surface-alt: #0f172a;
}
```

---

**Version**: 2.3.0
**Last Updated**: 2026-03-12
