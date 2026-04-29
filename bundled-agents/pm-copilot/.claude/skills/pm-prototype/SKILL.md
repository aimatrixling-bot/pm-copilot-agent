---
name: pm-prototype
displayName: 交互原型
displayDescription: 从 PRD/线框图生成可交互高保真原型
description: "Create high-fidelity interactive prototypes from PRD, wireframes, or descriptions. Use this skill whenever the user wants to build a clickable product demo, says '原型', 'prototype', '可交互原型', 'demo', 'mockup', or wants to visualize a product idea. Also trigger when the user says 'show me what it would look like' or 'let me play with it' after discussing features. Even rough feature descriptions like 'a dashboard for X' should trigger this skill to create something tangible."
user-invocable: true
argument-hint: "[PRD 路径 / 线框图路径 / 自然语言描述]"
---

# 高保真原型

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

从多种输入源生成高保真可交互原型。可点击的原型比 100 页文档更能传达产品意图。

**输入**: PRD / 线框图 / 自然语言 / 对话上下文
**输出**: 零配置可运行的 HTML 原型 + PRD 映射表

## Iron Law

| 铁律 | 违反后果 |
| --- | --- |
| 没有 PRD 或明确意图的原型是艺术项目 | 先确认产品目标和用户再动手 |
| 原型必须可交互（点击、输入、导航） | 纯静态页面不算原型，降级为线框图 |
| 视觉服务于产品目标，不是反过来 | 产品目标 > 视觉美感，时刻回到"用户要完成什么" |

## 反合理化

| 你可能在想的 | 真相 |
| --- | --- |
| "原型够漂亮就能说服老板" | 漂亮但不反映产品目标的原型 = 艺术品。产品目标 > 视觉美感 |
| "所有页面都用同一套紫色渐变+Inter 字体" | 通用美学 = 千篇一律 = 无记忆点。选择一个独特的美学基调并坚持 |
| "原型不是生产代码，随便写" | 随便写的原型 = 接后端时全部重写。数据结构应匹配预期 API |
| "先做完所有功能再添加交互" | 不可交互的原型 = 静态线框，降级。页面导航+表单输入=最低交互标准 |
| "不需要 MAPPING.md" | 没有 User Story↔页面映射 = 开发找不到需求对应 = 实现偏差 |

## 输入源模式

| 输入源 | 触发信号 | 处理方式 |
| --- | --- | --- |
| PRD 文件路径 | "基于这个 PRD 做原型" | Read PRD → 提取页面/流程 → 多页原型 |
| 线框图路径 | "从线框图做高保真" | Read 线框 → 增强视觉 → 添加交互 |
| 自然语言 | "做一个登录页原型" | 直接生成 → 确认细节 → 迭代 |
| 对话上下文 | PRD 讨论后说"做个原型看看" | 从对话提取需求 → 无需重新描述 |

## 四层架构

每个原型由四层构成，从产品目标到工程合规逐层递进：

### Layer 1: 产品框架（编码前必须定义）

| 维度 | 内容 |
| --- | --- |
| 产品目标 | 问题、目标类型（获取/激活/参与/变现）、指标 |
| 用户上下文 | 主要用户、情绪状态、专业水平 |
| 操作层次 | 1. 主要操作（唯一）2. 次要操作 3. 被动信息 |
| 差异化机制 | 选一个：布局/字体/动画/颜色/密度/交互 |

### Layer 2: 视觉系统

选择一个美学基调并坚持执行，**不要混合**：

| 基调 | 适用场景 | 特征 |
| --- | --- | --- |
| Editorial Authority | 内容平台、媒体 | 大标题，非对称，高对比 |
| Brutalist Raw | 开发者工具 | 单色，等宽，代码风格 |
| Industrial Utility | B2B 工具 | 密集，结构化，实用 |
| Retro-Futuristic | 科技、Web3 | 深色，霓虹，网格 |
| Luxury Minimal | 高端品牌 | 细线，轻量，慷慨留白 |
| Playful Modular | 教育、创意 | 鲜艳，圆润，动态 |
| Precision Enterprise | 企业软件 | 系统化，一致，专业 |

完整视觉系统指南见 `references/visual-systems.md`。

### Layer 3: 原型架构

| 原则 | 说明 |
| --- | --- |
| 模块化组件 | 可复用组件，清晰层次 |
| 数据分离 | 真实数据结构，无硬编码假指标 |
| 最小状态 | 本地状态策略，避免全局滥用 |
| API 就绪 | 数据结构匹配预期 API，最小重构可接后端 |

### Layer 4: 工程合规（内置）

| 检查项 | 要求 |
| --- | --- |
| 语义化 HTML | `<button>` 非 `<div onClick>` |
| 键盘导航 | 完整支持，清晰焦点指示 |
| 颜色对比 | WCAG AA (4.5:1 正文, 3:1 大字) |
| 触摸优化 | 按钮 ≥ 44px, `touch-action: manipulation` |

## 执行流程

```
1. 输入分析 → 提取页面结构、交互逻辑、数据模型
2. 产品框架 → 定义目标、用户、操作层次（Layer 1）
3. 视觉选择 → 选择美学基调 + 字体 + 颜色系统（Layer 2）
4. 架构规划 → 组件结构、数据流、状态管理（Layer 3）
5. 原型生成 → HTML + Tailwind CSS (CDN) + 可点击导航 + 假数据
6. 合规验证 → 检查 Layer 4 所有项
7. PRD 联动 → 版本标记 + User Story↔页面映射 + MAPPING.md
8. 交付 → 写入文件 + dev server 命令 + 映射表
```

## 参数

| 参数 | 类型 | 必需 | 默认值 |
| --- | --- | --- | --- |
| 输入源 | PRD/线框图/自然语言 | 是 | — |
| 技术栈 | html-tailwind/react | 否 | html-tailwind |
| 设备 | desktop/mobile/both | 否 | desktop |
| 美学基调 | 见上表 | 否 | 自动推荐 |
| 假数据量 | minimal/realistic | 否 | realistic |

## 设备适配

| 设备 | 布局策略 | 特殊处理 |
| --- | --- | --- |
| desktop | 固定宽度 1280px，侧边栏导航 | 鼠标 hover 效果 |
| mobile | 100% 宽度，底部导航栏 | 触控手势，大按钮 ≥ 44px |
| both | 响应式断点（768px/1024px） | 自动切换导航模式 |

## 交互标准

- [ ] 页面间导航可点击
- [ ] 表单可输入（无需验证）
- [ ] 按钮有 hover/active 反馈
- [ ] 列表可滚动
- [ ] 空状态和加载状态展示
- [ ] 移动端: 触控友好的点击区域（≥ 44px）

## 产出结构

```
prototype/
├── index.html          # 主入口
├── page-*.html         # 其他页面
├── data.js             # 假数据（匹配预期 API 结构）
└── MAPPING.md          # PRD↔原型映射表
```

## 常见错误（反模式）

| 错误 | 后果 | 正确做法 |
|------|------|----------|
| 通用美学（紫色渐变+Inter） | 千篇一律，无记忆点 | 选择独特视觉基调 |
| 非语义 HTML | 无障碍破坏，难维护 | 使用语义化元素 |
| 硬编码假数据 | 接后端需重写 | 匹配预期 API 结构 |
| 过度动画 | 干扰用户注意力 | 只动画有意义的交互 |
| 忽视状态 | 加载/错误/空状态缺失 | 每个组件定义所有状态 |

完整反模式列表见 `references/anti-patterns.md`。

## Hard Bans（硬禁令）

以下模式在所有保真度级别均禁止出现。检测到时立即修正。

| # | 禁止模式 | 修正动作 |
| --- | --------- | -------- |
| HB-1 | 出现超出该保真度级别的视觉元素（线框含品牌色/原型不可交互） | 回到当前保真度的约束范围 |
| HB-2 | 页面/屏幕没有目的声明 | 补充"这个页面让用户完成什么"后继续 |
| HB-3 | AI 功能没有用户控制点（输出用户无法编辑/拒绝） | 添加人类控制点（编辑/拒绝/重新生成） |
| HB-4 | 只展示正常状态，忽略空状态/加载/错误 | 每个关键组件补充异常状态 |
| HB-5 | 页面间无导航路径（孤立页面） | 补充完整的用户路径：入口→操作→目标 |

## 交付前检查

- [ ] 产品框架已定义（目标、用户、操作层次）
- [ ] 选择了一个美学基调并一致执行
- [ ] 使用独特字体（非 Inter/Roboto/Open Sans）
- [ ] 颜色系统使用 CSS 变量，对比度达标
- [ ] 所有交互可点击、可导航
- [ ] 数据结构匹配预期 API
- [ ] 语义化 HTML + 键盘导航
- [ ] MAPPING.md 已生成（User Story ↔ 页面映射）

## 与其他 Skill 的关系

| Skill | 关系 | 说明 |
|-------|------|------|
| pm-wireframe | 上游 | 快速结构沟通 → 原型增强 |
| pm-prd | 上游 | PRD → 提取页面和流程 |
| pm-comp | 参考 | 竞品 UI 可参考美学方向 |

## 残酷风险区

| 风险 | 场景 | 防御方案 |
|------|------|----------|
| 原型陷阱 | 利益相关者认为已完成 | 明确标注"原型"，加水印/边框 |
| 视觉主导 | 评审时关注颜色而非功能 | 从产品目标开始，功能 > 视觉 |
| 技术债 | 原型代码不适合生产 | 遵循框架最佳实践，记录债务 |
