---
name: pm-content-general
displayName: Content General
displayDescription: 通用内容生成
description: "Generate general content like blog posts, landing pages, release notes, and social media posts. Trigger when user says 'blog post', 'landing page', 'release note', '内容生成', 'social media', or needs non-WeChat content creation."
user-invocable: true
argument-hint: "[内容类型: blog/landing/release/social] [主题]"
---

# 通用内容生成

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

生成结构化的通用内容——博客文章、落地页、发布说明、社交媒体帖子。与 pm-writer 的区别：pm-writer 是公众号垂直领域（中文长文），pm-content-general 是通用中英文内容，覆盖多种格式和渠道。

**核心原则**：内容必须有目标受众，没有受众定义的内容是噪音。

## Iron Law（铁律）

| 铁律 | 违反后果 |
| --- | --- |
| 内容必须有 target audience 定义 | 停止——定义目标受众后再生成内容 |
| 不编造数据或引用 | 所有统计数据/引用必须标注来源；无来源时标注"需验证" |
| 发布前必须有人类审阅 | AI 生成的内容是草稿，不是终稿——标注 [Draft, pending review] |

## 反合理化

| 你可能在想的 | 真相 |
| --- | --- |
| "内容越长越好" | 目标受众决定长度——技术博客需要深度，社交媒体需要精炼 |
| "AI 生成的内容可以直接发布" | AI 内容必须有 human review，尤其是数据和引用 |
| "一个模板适用所有渠道" | 博客、落地页、社交媒体的格式、语气、CTA 完全不同 |
| "CTA 放最后就行" | CTA 必须明确且与内容自然衔接，不是硬塞在末尾 |

## Input

| 输入项 | 必需 | 说明 |
| --- | --- | --- |
| 内容类型 | 是 | blog / landing / release / social |
| 主题 | 是 | 内容的核心主题或产品/功能名称 |
| 目标受众 | 否 | 如未提供，推断并标注 [假设] |

## 内容类型规范

### blog — 博客文章

**结构**：
1. Hook（1-2 句抓住读者注意力）
2. 问题/背景（为什么这个话题重要）
3. 核心内容（分段落，每段一个要点）
4. 实践建议 / 洞察
5. CTA（评论/订阅/试用）

**语气**：专业但易读，第一人称或第二人称

### landing — 落地页

**结构**：
1. Hero Section（标题 + 副标题 + CTA）
2. Pain Point（用户痛点）
3. Solution（产品/功能如何解决）
4. Social Proof（数据/案例/引用，标注来源）
5. Features（3-5 个核心功能，每个 1-2 句）
6. Final CTA（与 Hero CTA 呼应）

**语气**：说服力强，简洁直接，SEO 友好

### release — 发布说明

**结构**：
1. 版本号 + 发布日期
2. 一句话概述
3. New Features（新增功能列表）
4. Improvements（改进项列表）
5. Bug Fixes（修复项列表）
6. Breaking Changes（如有）
7. Upgrade Guide（如需）

**语气**：技术性，精确，面向开发者或用户

### social — 社交媒体帖子

**结构**：
1. Hook（前 3 秒必须抓住注意力）
2. 核心信息（1-3 个要点）
3. CTA（明确动作：链接/评论/转发）

**格式要求**：
- Twitter/X: ≤ 280 字符
- LinkedIn: 150-300 字，专业语气
- 其他平台: 标注平台名，按平台规范调整

## 执行流程

```
触发 pm-content-general
    ├── 1. 确认内容类型和主题
    ├── 2. 确认目标受众（未提供则推断 + 标注 [假设]）
    ├── 3. 读取上下文
    │     ├── Glob 搜索项目已有文档
    │     └── 提取相关产品/功能信息
    ├── 4. 按内容类型生成草稿
    │     ├── 遵循对应结构规范
    │     ├── SEO 友好（标题含关键词、heading 清晰）
    │     └── CTA 明确且自然
    ├── 5. Iron Law 检查
    │     ├── 目标受众是否定义？
    │     ├── 数据/引用是否标注来源？
    │     └── 是否标注 [Draft, pending review]？
    └── 6. 交付草稿
```

## 输出规范

直接输出 Markdown 格式内容草稿。文档顶部包含元数据：

```
<!--
Type: blog | landing | release | social
Audience: [目标受众描述]
Status: Draft, pending review
Generated: YYYY-MM-DD
-->
```

## 交付前检查

- [ ] 目标受众已定义（不是"所有人"）
- [ ] 数据/引用全部标注来源，无来源标注"需验证"
- [ ] CTA 明确且与内容自然衔接
- [ ] 内容格式符合目标类型规范
- [ ] 标题包含核心关键词（SEO 友好）
- [ ] 标注 [Draft, pending review]

## 后续推荐

| 场景 | 推荐 Skill |
| --- | --- |
| 公众号长文 | pm-writer-draft（垂直领域） |
| 落地页 SEO 优化 | pm-seo |
| 产品发布 PRD | pm-prd |
| 竞品内容参考 | pm-comp |

## Metadata

```yaml
track: growth
depends_on: []
# schema_type & persist_to: v2 规划（当前运行时不读取，仅作为设计声明）
schema_type: free
guardrails:
  - 不编造数据或引用，无来源标注"需验证"
  - CTA 必须明确且与内容自然衔接
  - 内容 SEO 友好（标题含关键词、heading 清晰）
  - 标注 [Draft, pending review]
persist_to: ["projects/{project}/docs/content/"]
```
