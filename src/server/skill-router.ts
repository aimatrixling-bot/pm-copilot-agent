/**
 * Skill Router — Maps user message content to PM Skill names via keyword matching.
 *
 * Used for on-demand skill loading: before a new agent session starts,
 * routeToSkill() determines which skill to enable (disabling all others),
 * dramatically reducing the system prompt size (~147K → ~25-30K tokens).
 *
 * Routing rules extracted from CLAUDE.md intent routing table.
 * Unmatched messages fall back to loading all skills (safe degradation).
 */

// ─── Types ───

interface RoutingRule {
  /** Keywords/patterns that trigger this rule (case-insensitive match) */
  patterns: string[];
  /** Skill directory names to enable when matched */
  skills: string[];
  /** Priority: higher = checked first. Defaults to 0. */
  priority?: number;
}

// ─── Routing Rules ───

// Ordered by priority (most specific first) to avoid false matches.
// General patterns (e.g., "规划") come after specific ones (e.g., "路线图").
const ROUTING_RULES: RoutingRule[] = [
  // ── High priority: very specific keywords ──

  // Emergency (must match before general patterns)
  {
    priority: 10,
    patterns: ['紧急', 'ASAP', 'hotfix', '马上要', '急', 'fire', 'urgent'],
    skills: ['pm-urgent'],
  },

  // Problem framing (must match before general "问题" patterns)
  {
    priority: 5,
    patterns: ['问题是什么', '定义问题', '真问题', '伪需求', '问题定义', '用户痛点', 'problem frame', 'problem statement'],
    skills: ['pm-problem-frame'],
  },

  // ── Standard priority: skill-specific keywords ──

  // PRD
  {
    patterns: ['PRD', 'prd', '需求文档', '产品需求', '用户故事', 'feature spec', '需求规格'],
    skills: ['pm-prd'],
  },

  // Competitive analysis
  {
    patterns: ['竞品分析', '竞品对比', '竞品调研', '竞品', '对标分析', 'competitive analysis', 'benchmark'],
    skills: ['pm-comp'],
  },

  // Prototype
  {
    patterns: ['原型', 'prototype', 'mockup', 'demo', '高保真', '交互原型', '可交互'],
    skills: ['pm-prototype', 'pm-wireframe'],
  },

  // Wireframe
  {
    patterns: ['线框图', 'wireframe', '页面布局', 'layout', '页面结构', 'sketch'],
    skills: ['pm-wireframe'],
  },

  // Decision
  {
    patterns: ['做决策', '选方案', '方案对比', '决策', '方案比较', '选哪个', 'ADR', 'trade-off'],
    skills: ['pm-decision'],
  },

  // RICE prioritization
  {
    patterns: ['排优先级', 'RICE', '先做什么', '优先级排序', '需求排序', 'feature ranking'],
    skills: ['pm-rice'],
  },

  // Roadmap
  {
    patterns: ['路线图', 'roadmap', '季度规划', '产品规划', '里程碑', '排期', 'timeline'],
    skills: ['pm-roadmap'],
  },

  // Metrics
  {
    patterns: ['指标', 'KPI', 'North Star', '北极星指标', '指标体系', '度量', 'success metrics', '数据指标'],
    skills: ['pm-metrics'],
  },

  // Experiment
  {
    patterns: ['实验设计', 'A/B测试', '假设验证', 'AB测试', '对照实验', 'A/B test', 'hypothesis test'],
    skills: ['pm-experiment'],
  },

  // Retro
  {
    patterns: ['复盘', 'retro', '回顾', 'retrospective', 'post-mortem', 'Sprint 复盘', '迭代复盘'],
    skills: ['pm-retro'],
  },

  // Critique
  {
    patterns: ['审查', '评审', '检查质量', 'critique', 'review', '产品评审', '设计评审'],
    skills: ['pm-critique'],
  },

  // Discovery
  {
    patterns: ['产品发现', 'discovery', '从想法到验证', '想法验证', '机会评估', 'opportunity assessment', '产品探索'],
    skills: ['pm-discovery'],
  },

  // Feature cycle
  {
    patterns: ['功能开发', 'feature cycle', '从PRD到上线', '功能全流程', '交付全流程', 'feature lifecycle', 'feature pipeline'],
    skills: ['pm-feature-cycle'],
  },

  // Writer pipeline
  {
    patterns: ['批量文档', '文档集', 'writer pipeline', '文档管道', '文档全套', '完整文档包'],
    skills: ['pm-writer-pipeline'],
  },

  // Strategy session
  {
    patterns: ['策略讨论', 'strategy session', '快速决策', '方向讨论', '方向决策', '决策会议', '战略讨论'],
    skills: ['pm-strategy-session'],
  },

  // Data analysis
  {
    patterns: ['数据分析', '归因', '漏斗', '看板设计', '数据洞察', '根因分析', 'RCA', 'cohort', '留存'],
    skills: ['pm-data-analysis'],
  },

  // Persona
  {
    patterns: ['用户画像', 'persona', '目标用户', '用户角色', 'user persona', '受众分析'],
    skills: ['pm-persona'],
  },

  // Testing
  {
    patterns: ['测试计划', '验收测试', 'QA plan', '用户测试', '可用性测试', 'usability test', '验收标准'],
    skills: ['pm-testing'],
  },

  // Backlog
  {
    patterns: ['backlog', '迭代规划', 'Sprint', '待办', '需求池', '任务拆分', '需求管理'],
    skills: ['pm-backlog'],
  },

  // Tech spec
  {
    patterns: ['技术规格', '技术方案', '技术文档', '架构设计', 'tech spec', 'technical design'],
    skills: ['pm-tech-spec'],
  },

  // Eng request
  {
    patterns: ['工程需求', '开发任务', 'Jira', '工程需求单', '技术需求', '开发工单', '需求单'],
    skills: ['pm-eng-request'],
  },

  // Solution brief
  {
    patterns: ['方案概要', 'one-pager', 'executive summary', '方案概述', '一页纸方案', '方案总结'],
    skills: ['pm-solution-brief'],
  },

  // Launch
  {
    patterns: ['上线检查', '发布计划', 'go-live', '发布策略', 'rollout plan', '发布检查', 'launch'],
    skills: ['pm-launch'],
  },

  // Sync
  {
    patterns: ['项目同步', '状态更新', 'weekly update', '周报', '日报', '进度报告', 'status report', '项目摘要'],
    skills: ['pm-sync'],
  },

  // AI patterns
  {
    patterns: ['AI模式', 'AI设计模式', 'AI UX', 'AI交互', 'AI产品模式', '智能功能设计', 'AI patterns'],
    skills: ['pm-ai-patterns'],
  },

  // OST
  {
    patterns: ['技能树', '能力分析', 'PM能力', '职业发展', 'OST', 'open skill tree', '能力评估', '技能评估'],
    skills: ['pm-ost'],
  },

  // Job search
  {
    patterns: ['简历', '面试', 'PM求职', 'job search', 'cover letter', '求职信', '岗位匹配', 'JD分析'],
    skills: ['pm-job-search'],
  },
];

// ─── Public API ───

/**
 * Route a user message to one or more PM Skill names.
 *
 * @param message - The user's message text
 * @returns Array of skill directory names to enable. Empty array = no match (load all).
 */
export function routeToSkill(message: string): string[] {
  const lower = message.toLowerCase();

  // Sort by priority (highest first) for consistent matching
  const sorted = [...ROUTING_RULES].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0)
  );

  for (const rule of sorted) {
    if (rule.patterns.some(p => lower.includes(p.toLowerCase()))) {
      return rule.skills;
    }
  }

  return []; // No match → fallback to loading all skills
}

/**
 * Get all routing rules (for testing/debugging).
 */
export function getRoutingRules(): ReadonlyArray<Readonly<RoutingRule>> {
  return ROUTING_RULES;
}
