/**
 * Suggestions for the new chat page, covering PM Main Loop stages:
 * Problem → Decision → Spec → Prototype → Delivery → Learning
 */
export const chatSuggestions = [
  // Problem（问题定义）
  '帮我定义这个功能的用户问题和痛点',
  '我有一个产品想法，帮我用 JTBD 框架分析用户任务',
  '帮我画出目标用户画像，明确核心用户群体',
  '这个问题值得解决吗？帮我做问题框架化分析',

  // Decision（决策与优先级）
  '帮我用 RICE 框架给这些功能排优先级',
  '这两个方案各有利弊，帮我做结构化决策',
  '帮我评估一下先做 A 功能还是 B 功能',
  '列出这个方向的 3 个关键假设和验证方法',

  // Research（研究）
  '帮我做一份 Notion 和 Obsidian 的竞品分析',
  '搜索这个行业的市场规模和增长趋势',
  '帮我分析 [竞品名] 的产品定位和差异化空间',

  // Spec（需求文档）
  '帮我写一份 [产品名] 的 PRD',
  '帮我把这个产品想法转化为结构化的需求文档',
  '为这个功能写 3 个 User Story 和验收标准',
  '帮我写一份技术规格文档',

  // Planning（规划）
  '帮我做一个 Q2 的产品路线图',
  '规划这个产品未来 3 个月的里程碑',
  '帮我整理 Sprint Backlog，拆分用户故事',

  // Prototype（原型）
  '帮这个功能设计一个线框图',
  '基于这份 PRD 生成一个可交互的高保真原型',

  // Validation（验证）
  '帮我设计一个 A/B 测试方案验证这个假设',
  '定义这个产品的 North Star 指标和护栏指标',
  '帮我设计用户访谈提纲，验证这个需求',

  // Quality（质量）
  '帮我审查这份 PRD，找出逻辑漏洞和矛盾',
  '为这个功能制定测试计划和验收标准',

  // Delivery（交付）
  '帮我做一份上线前检查清单',
  '规划这个功能的灰度发布和回滚方案',

  // Growth（增长与复盘）
  '这个功能上线一周了，帮我做数据复盘',
  '帮我做一次 Sprint 回顾，提炼改进点',

  // AI Pattern（AI 产品模式）
  '这个 AI 功能应该用什么交互模式？帮我分析',
  '帮我设计一个 AI 功能的降级方案',

  // Workflow（快速触发）
  '/pm-prd 帮我写一份需求文档',
  '/pm-comp 分析一下这个赛道的竞品格局',
  '/pm-rice 帮我排一下功能优先级',
  '/pm-roadmap 做一个产品路线图',
  '/pm-decision 帮我在两个方案之间做选择',
];

/**
 * Get a random suggestion from the list.
 */
export function getRandomSuggestion(): string {
  const randomIndex = Math.floor(Math.random() * chatSuggestions.length);
  return chatSuggestions[randomIndex];
}
