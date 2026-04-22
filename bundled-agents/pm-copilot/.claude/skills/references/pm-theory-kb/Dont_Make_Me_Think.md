# Don't Make Me Think, Revisited — 关键模型提炼

> 从 257 页中提炼出 PM/UX 从业者最需要掌握的核心模型，按使用频率排序。

---

## 1. Krug 第一可用性定律（Don't Make Me Think）

**来源**: Ch 1, p28-38 | **PM 相关度**: ⭐⭐⭐

> "Don't make me think!" — 让页面不言自明（Self-evident）、显而易见（Obvious）、自我解释（Self-explanatory）。

**认知负荷模型**：

```
Self-Evident ──────────────────── Truly Obscure
  │                                    │
  "OK，这就是     "这是什么？    "这到底在
   我要找的东西"    这能点吗？"     哪里？"
  │                │             │
  ✓ 零思考         ⚠ 微思考      ✗ 认知过载
```

**关键推论**：
- 每个问号都在增加用户的 **Cognitive Workload**（认知负荷）
- 用户不应花时间思考：我在哪？从哪开始？XX 在哪？怎么用？
- 适度 vs 过度：无法让一切不言自明时，至少做到 **Self-explanatory**（自我解释）

---

## 2. 用户行为的三个事实（Facts of Life）

**来源**: Ch 2, p39-47 | **PM 相关度**: ⭐⭐⭐

### Fact #1: We scan, we don't read
用户**扫描**而非阅读。原因：
- 我们通常在**赶时间**
- 我们知道自己**不需要读完所有内容**
- 我们擅长**扫描**（日常练习）

### Fact #2: We satisfice, we don't optimize
用户选择**第一个差不多合理的选项**（Satisfice = Satisfy + Suffice），而非最优解。原因：
- 优化是**费力的**
- 如果猜错了，**代价通常不高**（Back 按钮永远在）
- **没有时间**仔细权衡所有选项

### Fact #3: We muddle through, we don't figure out
用户**胡乱应付**而非真正理解系统运作方式。原因：
- 理解系统对当前任务**并不必要**
- 如果找到了能用的方式，就**不会再探索更好的方式**

**PM 启示**：不要指望用户会阅读说明、会探索所有功能、会做出最优选择。设计应服务于扫描、满意即可、胡乱应付的行为模式。

---

## 3. 广告牌设计六原则（Billboard Design 101）

**来源**: Ch 3, p48-70 | **PM 相关度**: ⭐⭐⭐

为扫描而设计的 6 条原则：

| # | 原则 | 核心要点 |
|---|------|---------|
| 1 | **Conventions are your friends** | 遵循既有约定（位置、样式、交互），除非你有明确更好的方案 |
| 2 | **Create effective visual hierarchies** | 视觉层次：最重要的最突出；逻辑关联的视觉分组；视觉层次反映内容结构 |
| 3 | **Break pages into clearly defined areas** | 明确分区：让用户一眼看出页面的信息架构 |
| 4 | **Make it obvious what's clickable** | 可点击性：让用户**永远不需要花一毫秒**判断什么能点 |
| 5 | **Keep the noise down** | 降低噪音：去掉视觉噪音（眼球吸尘器）、不必要的文字 |
| 6 | **Format text to support scanning** | 扫描友好：使用标题、列表、加粗、缩进等格式辅助扫描 |

**Convention 的使用决策模型**：
```
遵循约定？ ──是──→ 默认遵循
   │
   否 → 你确定有更好的方案？
              │
         是 → 新方案是否 (a) 不需要学习成本 或 (b) 价值远超学习成本？
              │                                      │
              否 → 回到约定                          是 → 创新
```

---

## 4. 导航设计模型（Street Signs & Breadcrumbs）

**来源**: Ch 6, p82-113 | **PM 相关度**: ⭐⭐⭐

### Persistent Navigation（持久导航）的要素

| 要素 | 说明 |
|------|------|
| **Site ID / Logo** | 每页都有，告诉用户"你在哪" |
| **Sections（主要分区）** | 站点的主要内容分类 |
| **Utilities（工具区）** | 不属于主要内容的辅助链接（如帮助、登录、购物车） |
| **Search** | 搜索框 |
| **Home 链接** | 一键回到首页 |

### Trunk Test（树干测试）

闭上眼睛，打开任意页面，回答以下问题：
1. **What site is this?**（这是什么网站？）— Site ID
2. **What page am I on?**（我在哪个页面？）— Page name
3. **What are the major sections of this site?**（主要分区？）— Sections
4. **What are my options at this level?**（当前层级选项？）— Navigation
5. **Where am I in the scheme of things?**（我在整体结构中的位置？）— Breadcrumbs/Traces
6. **How can I search?**（怎么搜索？）— Search

### Breadcrumbs（面包屑）

显示用户在层级结构中的位置，提供快速回溯路径。

---

## 5. 首页设计模型（The Big Bang Theory）

**来源**: Ch 7, p114-130 | **PM 相关度**: ⭐⭐⭐

首页需要回答的 4+1 个问题：

| # | 问题 | 对应元素 |
|---|------|---------|
| 1 | What is this?（这是什么？） | Site ID + Tagline |
| 2 | What do they have here?（这里有什么？） | 主要分区导航 |
| 3 | What can I do here?（我能做什么？） | Call-to-Action |
| 4 | Why should I be here — and not somewhere else?（为什么在这里？） | Value Proposition |
| 5 | Where do I start?（从哪开始？） | 明确的入口引导 |

**Tagline 黄金法则**：好的 Tagline 应该能回答"这个网站是做什么的"和"为什么我应该在这里"。

---

## 6. DIY 可用性测试模型（Usability Testing on 10 Cents a Day）

**来源**: Ch 9, p141-172 | **PM 相关度**: ⭐⭐⭐

### 核心原则

> "Focus groups are not usability tests." — 焦点小组 ≠ 可用性测试

### DIY 测试的关键参数

| 参数 | Krug 的建议 |
|------|------------|
| **频率** | 每个月 1 次（每个迭代周期） |
| **人数** | 3-4 人就够了（一个上午） |
| **参与者** | 真实用户或接近目标用户的人 |
| **地点** | 任何安静的地方 / 远程也行 |
| **测试者** | 任何人（不需要专家） |
| **观察者** | 整个团队都应观看 |
| **时机** | 越早越好，任何阶段 |

### 测试流程

```
1. 欢迎参与者，说明规则（Think aloud, 不是测试你）
2. 给出任务场景（不是步骤指令）
3. 观察并记录
4. 可以在过程中追问（"你在找什么？"）
5. 测试结束后做 Debriefing
6. 识别最严重的问题，优先修复
```

**关键洞察**：3 个用户就能发现大部分可用性问题；第 1 个用户发现最多，后续用户发现的问题逐渐递减但仍有价值。

---

## 7. Goodwill 储备模型（The Reservoir of Goodwill）

**来源**: Ch 11, p203-211 | **PM 相关度**: ⭐⭐⭐

用户进入网站时带着一个 **Goodwill 储备池**，每次遇到问题都会消耗，每次好的体验都会补充。

```
         满水位 ═══════════════════════════
                │   ✓ 页面加载快
                │   ✓ 结构清晰
                │   ✓ 信息准确
                │   ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
                │   ✗ 隐藏关键信息
                │   ✗ 强迫注册才能浏览
                │   ✗ 404 页面无帮助
                │   ✗ 不必要的步骤
                │   ✗ 误导性链接
         干涸 ═══════════════════════════
                离开网站 / 负面口碑
```

**消耗 Goodwill 的典型行为**：
- 隐藏用户需要的信息
- 没有明确的错误提示
- 要求不必要的注册
- 不合理的默认设置
- 网站表现与承诺不符

**增加 Goodwill 的典型行为**：
- 知道用户可能想问什么，提前回答
- 提供方便的捷径
- 原谅用户的错误（如自动保存、撤销）
- 让用户感到被尊重和关怀

---

## 8. 团队争论解决模型（The Antidote for Religious Debates）

**来源**: Ch 8, p131-140 | **PM 相关度**: ⭐⭐

### 争论的根源

| 层次 | 原因 |
|------|------|
| **个人偏好** | "我觉得这样好" — 每个人都是 Web 用户，都有自己的偏好 |
| **职业视角** | 设计师重美观、开发者重逻辑、PM 重业务、老板重品牌 |
| **平均用户谬误** | "大多数用户应该和我一样" — 错误假设 |

### 解药：Usability Testing

> "与其争论不休，不如让真实用户来回答。"

可用性测试是解决"宗教辩论"的唯一可靠方法。它将争论从"谁的观点更强"转向"用户实际表现如何"。

---

## 9. 移动端设计取舍模型

**来源**: Ch 10, p173-202 | **PM 相关度**: ⭐⭐

### 移动端 vs 桌面端的关键差异

| 维度 | 桌面端 | 移动端 |
|------|--------|--------|
| **空间** | 充裕 | 极其有限 |
| **输入** | 键盘+鼠标 | 触摸 |
| **上下文** | 专注使用 | 随时随地、碎片化 |
| **带宽/延迟** | 稳定 | 不稳定 |
| **Hover** | 有 | 无 |

### 移动端设计核心原则

1. **不要隐藏 Affordance**（可操作性暗示）— 没有光标就没有 Hover，按钮必须看起来可点
2. **触摸目标要足够大** — 最小 44×44 pt（Apple HIG）
3. **减少层级** — 每多一层都是用户摩擦
4. **Delightful is the new black** — 移动端更注重愉悦感
5. **Learnable & Memorable** — 用户可能随时中断再回来

---

## 10. 无障碍设计四步法（Accessibility）

**来源**: Ch 12, p212-222 | **PM 相关度**: ⭐⭐

> "Accessibility is not just about blind users. It benefits everyone."

### 立即可做的 4 件事

| # | 行动 | 说明 |
|---|------|------|
| 1 | **修复困扰所有人的可用性问题** | 很多无障碍问题也是所有人的问题 |
| 2 | **读一篇文章** | 了解 WCAG 基本原则 |
| 3 | **读一本书** | 如 "Just Ask: Integrating Accessibility Throughout Design" |
| 4 | **摘取低垂果实** | Alt text、键盘导航、颜色对比度 |

---

## 快速参考：全书核心概念索引

| 概念 | 章节 | 一句话 |
|------|------|--------|
| Don't make me think | Ch 1 | 页面应不言自明 |
| Scanning | Ch 2 | 用户扫描而非阅读 |
| Satisficing | Ch 2 | 用户满意即可而非追求最优 |
| Muddling through | Ch 2 | 用户胡乱应付而非理解系统 |
| Convention | Ch 3 | 遵循既有约定降低学习成本 |
| Visual Hierarchy | Ch 3 | 视觉层次反映内容结构 |
| Navigation | Ch 4, 6 | 持久导航 + 树干测试 |
| Omit needless words | Ch 5 | 砍掉所有不影响理解的文字 |
| Homepage design | Ch 7 | 回答 5 个核心问题 |
| Usability Testing | Ch 9 | 每月 3 个用户，一个上午 |
| Goodwill | Ch 11 | 用户体验像银行账户，有存有取 |
| Accessibility | Ch 12 | 先修所有人的问题，再处理特殊需求 |
