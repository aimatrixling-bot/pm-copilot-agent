---
name: pm-seo
displayName: SEO
displayDescription: SEO 策略与审计
description: "SEO strategy and audit for websites. Trigger when user says 'seo', '搜索引擎优化', '关键词策略', 'sitemap', '结构化数据', 'meta tags', or needs to improve search engine visibility."
user-invocable: true
argument-hint: "[网站 URL 或页面描述]"
---

# SEO 策略与审计

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

系统化评估网站的搜索引擎可见性，输出可执行的优化方案。SEO 不是一次性工程，是持续优化循环。

**核心原则**：没有数据的 SEO 建议是空谈——每条建议必须有具体实施步骤。

## Iron Law（铁律）

| 铁律 | 违反后果 |
| --- | --- |
| 不编造搜索量数据 | 所有搜索量/趋势数据必须标注来源；无来源时标注"需验证" |
| SEO 建议必须有具体实施步骤 | 停止——补充具体 HTML/配置/内容修改步骤后继续 |
| 技术 SEO 和内容 SEO 分开评估 | 混淆两者会导致优先级错乱，必须分别列出 |

## 反合理化

| 你可能在想的 | 真相 |
| --- | --- |
| "堆关键词就能排上去" | 现代 SEO 是语义理解 + 用户体验，关键词堆砌会被惩罚 |
| "SEO 是一次性的事" | 搜索算法持续更新，SEO 是持续优化循环 |
| "meta keywords 很重要" | Google 早已不使用 meta keywords，聚焦 meta description + structured data |
| "外链越多越好" | 质量 > 数量，低质量外链会导致惩罚 |

## Input

| 输入项 | 必需 | 说明 |
| --- | --- | --- |
| 网站/页面 URL | 是 | 待审计的目标页面 |
| 目标关键词 | 否 | 如未提供，基于页面内容推断并标注 [假设] |

## 执行流程

```
触发 pm-seo
    ├── 1. 信息收集
    │     ├── 读取页面内容（如可访问）
    │     ├── 提取现有 meta tags、heading 结构、内链
    │     └── 识别技术栈和部署方式
    ├── 2. 技术 SEO 审计
    │     ├── 页面可索引性（robots.txt、noindex、canonical）
    │     ├── 页面速度（Core Web Vitals 关注点）
    │     ├── 移动端适配
    │     ├── HTTPS / 安全性
    │     ├── URL 结构
    │     └── Sitemap / 结构化数据
    ├── 3. 内容 SEO 评估
    │     ├── 关键词覆盖和语义相关性
    │     ├── 标题和描述优化
    │     ├── Heading 层级（H1-H6）
    │     ├── 内容质量和深度
    │     └── 内链结构
    ├── 4. 关键词策略
    │     ├── 主关键词识别
    │     ├── 长尾关键词机会
    │     └── 竞争难度评估（标注"需验证"）
    ├── 5. 优先级排序
    │     └── 按影响 × 实施难度矩阵排列
    └── 6. 输出审计报告
```

## 输出结构

### technical_seo

| 检查项 | 当前状态 | 问题 | 修复步骤 | 优先级 |
| --- | --- | --- | --- | --- |
| robots.txt | ... | ... | ... | P0/P1/P2 |
| meta description | ... | ... | ... | ... |
| canonical tag | ... | ... | ... | ... |
| structured data | ... | ... | ... | ... |
| Core Web Vitals | ... | ... | ... | ... |
| 移动端 | ... | ... | ... | ... |

### content_seo

| 检查项 | 当前状态 | 建议 | 修复步骤 | 优先级 |
| --- | --- | --- | --- | --- |
| H1 标签 | ... | ... | ... | ... |
| 关键词密度 | ... | ... | ... | ... |
| 内链数量 | ... | ... | ... | ... |
| 内容长度 | ... | ... | ... | ... |

### keywords

| 关键词 | 类型 | 搜索意图 | 建议使用位置 | 数据来源 |
| --- | --- | --- | --- | --- |
| ... | 主词/长尾/LSI | 信息/导航/交易 | ... | 实际来源或"需验证" |

### structured_data

- 建议添加的 Schema.org 类型（如 Article、FAQ、BreadcrumbList）
- JSON-LD 示例代码片段

### priority_actions

按影响 × 难度排序的行动清单，每条包含：
1. 具体做什么（what）
2. 在哪里做（where）
3. 怎么做（how — 代码/配置级别）
4. 预期效果（expected impact）

## 交付前检查

- [ ] 搜索量/趋势数据全部标注来源，无来源标注"需验证"
- [ ] 每条建议都有具体实施步骤（不是"优化标题"而是"将 `<title>` 改为 `X | Y | Z`"）
- [ ] 技术 SEO 和内容 SEO 明确分区
- [ ] 优先级有依据（不是全部标 P0）
- [ ] 结构化数据建议包含可用的 JSON-LD 示例

## 后续推荐

| 场景 | 推荐 Skill |
| --- | --- |
| 需要竞品 SEO 对比 | pm-comp |
| 需要生成 SEO 友好的落地页内容 | pm-content-general |
| 需要写含 SEO 的 PRD | pm-prd |

## Metadata

```yaml
track: growth
depends_on: []
# schema_type & persist_to: v2 规划（当前运行时不读取，仅作为设计声明）
schema_type: hybrid
guardrails:
  - 不编造搜索量数据，无来源标注"需验证"
  - 每条建议必须 actionable（有具体实施步骤）
  - 技术 SEO 和内容 SEO 分开评估和输出
persist_to: ["projects/{project}/docs/seo-audit.md"]
```
