---
name: pm-wireframe
displayName: 线框图
displayDescription: 快速产出低保真线框图验证页面布局
description: "Create low-fidelity wireframes to visualize page layouts and UI structure. Use this skill whenever the user wants to sketch a page layout, says '线框图', 'wireframe', '页面布局', 'layout', '页面结构', 'sketch', or needs to quickly visualize how a page should be organized. Also trigger when the user says 'what should this page look like' or 'how should we lay out X'. This is the fastest way to go from idea to visible structure — use before pm-prototype for quick alignment."
user-invocable: true
argument-hint: "[PRD 路径或页面描述]"
---

# 低保真线框图

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

从 PRD/功能描述快速生成低保真线框图。线框不是设计，是沟通工具——5 分钟内从想法到可见结构。

**输入**: PRD 文件路径或页面描述
**输出**: 低保真线框图（HTML 或 ASCII）+ 用户流程图

## 与 prototype 的区别

| 维度 | wireframe (本 Skill) | pm-prototype |
| --- | --- | --- |
| 输出 | ASCII/灰度 HTML | 可交互 HTML + CSS + JS |
| 制作时间 | ~5 分钟 | ~30 分钟 |
| 用途 | 团队内部快速对齐结构 | 用户测试、外部演示 |
| 保真度 | 低保真结构图 | 中保真可交互 |
| 可点击 | 否 | 是 |

**选择规则**: 先 wireframe 对齐结构 → 再 prototype 做交互演示。

## Iron Law

| 铁律 | 违反后果 |
| --- | --- |
| 线框不包含视觉设计 | 如果有颜色/字体/图标 → 降级为设计稿，重新做线框 |
| 每个页面必须有目的声明 | 立即停止——补充"这个页面让用户完成什么"后继续 |
| 流程完整性 | 从入口到目标达成的完整路径，不能跳步 |

## 执行流程

```
1. Read PRD 或接收页面描述
2. 提取关键屏幕和导航关系
3. 定义用户流程（入口 → 屏幕1 → 屏幕2 → 目标）
4. 为每个屏幕创建线框
   ├── 确定目的（这个屏幕让用户完成什么）
   ├── 绘制布局（header/nav/main/sidebar/footer）
   ├── 标注组件（[按钮] [列表] [表单] [图片]）
   ├── 标注交互（点击跳转、弹窗说明）
   └── 考虑状态（正常/空/加载/错误）
5. 产出线框文件
```

### IA Analysis Mode（信息架构优先）

当用户关注信息组织、导航结构、内容分类时启用此模式：

1. **内容盘点** — 列出所有需要组织的内容/功能
2. **卡片分类** — 建议开放式或封闭式分类方法（见 `references/ia-analysis-guide.md`）
3. **导航结构** — 输出站点地图（Max 3 层）
4. **内容模型** — 定义内容类型和关系
5. **验证方法** — 建议树状测试或首次点击测试

## 参数

| 参数 | 类型 | 必需 | 默认值 |
| --- | --- | --- | --- |
| 输入源 | PRD路径/文本 | 是 | — |
| 输出格式 | ascii/html | 否 | html |
| 页面列表 | 文本 | 否 | 从 PRD User Stories 提取 |

## 线框标准

### HTML 线框

- 灰度配色（#333/#666/#999/#eee），无品牌色
- 组件占位（`[按钮]` `[列表]` `[表单]` `[图片]`）
- 交互标注（点击跳转路径、弹窗触发说明）
- 响应式断点标注（768px/1024px）

### ASCII 线框

```
┌─────────────────────────────────┐
│ Header: Logo    Nav    [Login]  │
├─────────┬───────────────────────┤
│ Sidebar │  Main Content         │
│ [Menu]  │  ┌─────────────────┐  │
│ [Item1] │  │ [Hero Section]  │  │
│ [Item2] │  │ [CTA Button]    │  │
│         │  └─────────────────┘  │
│         │  ┌─────────────────┐  │
│         │  │ [Feature Grid]  │  │
│         │  └─────────────────┘  │
├─────────┴───────────────────────┤
│ Footer: Links   Copyright      │
└─────────────────────────────────┘
```

## 每个屏幕包含

| 维度 | 内容 |
| --- | --- |
| Purpose | 这个屏幕让用户完成什么 |
| Layout | ASCII/HTML 布局表示 |
| Content | 每个区域的元素描述 |
| Components | UI 组件列表（按钮/表单/列表等） |
| Interactions | 触发和结果 |
| States | 正常/空/加载/错误 |
| Transitions | 到其他屏幕的导航方式 |

## 常见错误

| 错误 | 后果 | 正确做法 |
| --- | --- | --- |
| 过早关注美观 | 偏离线框目的 | 只用文字和简单形状 |
| 过多细节 | 低保真变高保真 | 保持抽象 |
| 忽略流程 | 单屏视角 | 先画流程再画单屏 |
| 跳过状态 | 只考虑正常 | 考虑空/加载/错误 |
| 没有标注交互 | 不知道怎么用 | 每个可点击元素标注去向 |

## 交付前检查

- [ ] 每个页面有目的声明
- [ ] 用户流程完整（入口到目标）
- [ ] 页面间导航关系已标注
- [ ] 所有关键状态已考虑（正常/空/加载/错误）
- [ ] 组件用占位符（非真实内容）
- [ ] 无视觉设计（无颜色/字体/图标）
- [ ] 支持响应式标注

## 后续推荐

| 场景 | 推荐 Skill |
| --- | --- |
| 需要可交互演示 | pm-prototype |
| 需要设计系统 | pm-prototype（带美学基调） |
| 需要从 PRD 开始 | pm-prd → pm-wireframe → pm-prototype |
| 需要信息架构分析 | pm-wireframe IA Analysis Mode |
