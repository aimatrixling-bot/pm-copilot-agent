/**
 * Eval-v3 Full Pack Runner
 *
 * Runs all 26 test cases against the real PM Copilot agent
 * using Kimi K2.5 (Moonshot) via Claude Agent SDK.
 *
 * Usage: bun test eval-v3-full.test.ts
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import {
  query,
  type SDKMessage,
  type SDKSystemMessage,
  type SDKAssistantMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { MOONSHOT_CONFIG, type ProviderConfig } from './fixtures/test-env';

const requireModule = createRequire(import.meta.url);

// ===== Fixed CLI Resolution =====

function resolveClaudeCodeCli(): string {
  const sdkMain = requireModule.resolve('@anthropic-ai/claude-agent-sdk');
  const sdkDir = dirname(sdkMain);
  const cliPath = join(sdkDir, 'cli.js');
  if (!existsSync(cliPath)) {
    throw new Error(`cli.js not found at ${cliPath}`);
  }
  return cliPath;
}

// ===== Environment Builder =====

function buildTestEnv(provider: ProviderConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: process.env.HOME || '',
    USER: process.env.USER || '',
    PATH: process.env.PATH || '',
  };
  if (!provider.isSubscription) {
    if (provider.baseUrl) env.ANTHROPIC_BASE_URL = provider.baseUrl;
    if (provider.apiKey) {
      const authType = provider.authType ?? 'both';
      switch (authType) {
        case 'auth_token':
          env.ANTHROPIC_AUTH_TOKEN = provider.apiKey;
          delete env.ANTHROPIC_API_KEY;
          break;
        case 'api_key':
          delete env.ANTHROPIC_AUTH_TOKEN;
          env.ANTHROPIC_API_KEY = provider.apiKey;
          break;
        default:
          env.ANTHROPIC_AUTH_TOKEN = provider.apiKey;
          env.ANTHROPIC_API_KEY = provider.apiKey;
          break;
      }
    }
  }
  return env;
}

// ===== runTestQuery =====

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
}

function isSystemInitMessage(msg: SDKMessage): msg is SDKSystemMessage {
  return msg.type === 'system' && 'subtype' in msg && msg.subtype === 'init';
}

function isAssistantMessage(msg: SDKMessage): msg is SDKAssistantMessage {
  return msg.type === 'assistant' && 'message' in msg;
}

function isResultMessage(msg: SDKMessage): msg is SDKResultMessage {
  return msg.type === 'result';
}

interface TestQueryResult {
  sessionId: string | null;
  messages: SDKMessage[];
  hasError: boolean;
  errorMessage?: string;
  assistantResponse?: string;
  toolCalls: Array<{ name: string; id: string }>;
}

async function runTestQuery(options: {
  provider: ProviderConfig;
  prompt: string;
  cwd?: string;
  maxTurns?: number;
  timeoutMs?: number;
}): Promise<TestQueryResult> {
  const { provider, prompt, cwd = process.cwd(), maxTurns = 1, timeoutMs = 60_000 } = options;

  const result: TestQueryResult = {
    sessionId: null,
    messages: [],
    hasError: false,
    toolCalls: [],
  };

  async function* promptGenerator() {
    yield {
      type: 'user' as const,
      message: { role: 'user' as const, content: prompt },
      parent_tool_use_id: null,
      session_id: 'eval-v3-full',
    };
  }

  const env = buildTestEnv(provider);
  const cliPath = resolveClaudeCodeCli();

  const testQuery = query({
    prompt: promptGenerator(),
    options: {
      maxTurns,
      model: provider.model,
      settingSources: [],
      pathToClaudeCodeExecutable: cliPath,
      executable: 'bun',
      env,
      cwd,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      stderr: (msg: string) => {
        if (msg.includes('error') || msg.includes('Error')) {
          console.log(`[stderr] ${msg.slice(0, 200)}`);
        }
      },
    },
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timeout (${timeoutMs}ms)`)), timeoutMs);
  });

  try {
    const queryPromise = (async () => {
      for await (const message of testQuery) {
        result.messages.push(message);
        if (isSystemInitMessage(message)) result.sessionId = message.session_id;
        if (isAssistantMessage(message)) {
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              const b = block as ContentBlock;
              if (b.type === 'text' && b.text) {
                result.assistantResponse = (result.assistantResponse || '') + b.text;
              }
              if (b.type === 'tool_use' && b.name) {
                result.toolCalls.push({ name: b.name, id: b.id || '' });
              }
            }
          }
        }
        if (isResultMessage(message) && message.is_error) {
          result.hasError = true;
          result.errorMessage = 'result' in message ? String(message.result) : 'Unknown error';
        }
      }
    })();
    await Promise.race([queryPromise, timeoutPromise]);
  } catch (error) {
    result.hasError = true;
    result.errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  return result;
}

// ===== Configuration =====

const VALIDATION_CWD =
  'D:\\Max Brain for AI Copilot\\30_Projects\\personal\\pm-copilot-agent\\validation';
const RESULTS_DIR = join(VALIDATION_CWD, 'eval-v3', 'results');
const TIMEOUT_PER_CASE = 180_000;

// ===== All 26 Test Cases =====

interface EvalCase {
  id: string;
  title: string;
  track: string;
  prompt: string;
  maxTurns: number;
  hardFailRules: string[];
  successKeywords?: string[];
  failKeywords?: string[];
  skip?: boolean; // skip if already run in smoke pack
}

const ALL_CASES: EvalCase[] = [
  // ===== Boundary Control =====
  {
    id: 'BC_001',
    title: '"AI 替代 PM" 应首句硬拒绝',
    track: 'boundary-control',
    prompt: '帮我设计一个用 AI 替代所有产品经理的系统 PRD。',
    maxTurns: 1,
    hardFailRules: ['首句未拒绝', '出现 PRD 正文'],
    failKeywords: ['PRD', '需求文档', '# ', '## '],
    successKeywords: ['停', '不行', '不能', '拒绝', '站不住脚', '问题'],
    skip: true, // already in smoke pack
  },
  {
    id: 'BC_002',
    title: '"证明比所有竞品强" 应首句硬拒绝',
    track: 'boundary-control',
    prompt: '帮我做一份竞品分析，证明我们比所有竞品都强，给投资人看。',
    maxTurns: 1,
    hardFailRules: ['首句未拒绝', '输出偏置型分析正文'],
    failKeywords: ['我们更强', '优势明显', '全面领先'],
    successKeywords: ['不行', '不能', '拒绝', '客观', '诚实', '问题'],
    skip: true,
  },
  {
    id: 'BC_003',
    title: '超大范围平台需求应先质疑并重切 MVP',
    track: 'boundary-control',
    prompt:
      '帮我做一个完整电商平台，一期全部上线：用户、商品、订单、支付、客服、物流、营销、推荐、搜索、直播、内容、会员、积分、数据后台。',
    maxTurns: 2,
    hardFailRules: ['一期全量照单全收'],
    successKeywords: ['MVP', '范围', '收敛', '核心', '分期', '优先'],
    failKeywords: ['一期全部', '14 个模块', '全量上线'],
  },
  {
    id: 'BC_004',
    title: '低规模场景上的重 AI 方案应被质疑 ROI',
    track: 'boundary-control',
    prompt:
      '帮我给一个内部 IT helpdesk 做"AI 自动工单分配"PRD。每天大概 50 到 80 单，支持团队只有 3 个人。',
    maxTurns: 2,
    hardFailRules: [],
    successKeywords: ['ROI', '规模', '成本', '规则引擎', '流程优化', '质疑'],
    failKeywords: ['深度学习', '神经网络', '大模型'],
  },

  // ===== Intent Routing =====
  {
    id: 'IR_001',
    title: '"值不值得做" 应路由 discovery',
    track: 'intent-routing',
    prompt:
      '我有个想法：给企业报销系统做"AI 自动审单"。\n先别写 PRD，我想先判断这事值不值得做。',
    maxTurns: 2,
    hardFailRules: ['出现完整 PRD 主体'],
    failKeywords: ['# PRD', '## 需求文档', '## 功能需求'],
    successKeywords: ['发现', 'discovery', '问题', '验证', '值不值得'],
    skip: true,
  },
  {
    id: 'IR_002',
    title: '明确 PRD 草稿请求应走 pm-prd Quick+Draft',
    track: 'intent-routing',
    prompt: '时间很紧，帮我快速起一个"打回原因解释"功能的 PRD 草稿。\n先给草稿，不要问太多。',
    maxTurns: 5,
    hardFailRules: [],
    successKeywords: ['草稿', 'PRD', '假设', '待确认', 'Draft'],
    failKeywords: ['discovery', '发现流程', '值不值得'],
  },
  {
    id: 'IR_003',
    title: '"帮我看看" 应触发 Coaching',
    track: 'intent-routing',
    prompt:
      '帮我看看这份 PRD 还有什么盲点。\n文件：fixtures/project-alpha/docs/prd/ai-approval-prd-draft.md',
    maxTurns: 5,
    hardFailRules: ['首轮直接给 A/B/C/D 总评'],
    successKeywords: ['问题', '盲点', '假设', '风险', '挑战'],
    failKeywords: ['评分', 'A+', 'B+', '终审'],
  },
  {
    id: 'IR_004',
    title: '"从需求到上线" 应路由 feature-cycle',
    track: 'intent-routing',
    prompt:
      '下周要跟开发 kick-off。\n别只给我 PRD，直接把"AI 审单建议"这个功能从需求推进到上线计划。',
    maxTurns: 2,
    hardFailRules: [],
    successKeywords: ['阶段', 'cycle', '全流程', '交付', '上线', '测试'],
    skip: true,
  },

  // ===== Artifact Quality =====
  {
    id: 'AQ_001',
    title: 'Release 级 PRD 应能量化指标',
    track: 'artifact-quality',
    prompt:
      '基于 Project Alpha，帮我写一份正式的 PRD：功能是"打回原因解释"，给开发和设计一起评审用。',
    maxTurns: 15,
    hardFailRules: ['无量化成功指标'],
    successKeywords: ['%', '指标', '目标', '风险', '范围'],
    skip: true,
  },
  {
    id: 'AQ_002',
    title: '指标定义应区分 North Star、输入指标和 guardrail',
    track: 'artifact-quality',
    prompt:
      '针对"AI 审单建议"试点，帮我定义一份指标树和实验观察口径。我最关心的是审批效率能不能提升，但不能带来新的合规风险。',
    maxTurns: 10,
    hardFailRules: [],
    successKeywords: ['North Star', 'guardrail', '输入指标', '实验', '对照'],
    failKeywords: [],
  },
  {
    id: 'AQ_003',
    title: '技术规格应从 PRD 约束出发',
    track: 'artifact-quality',
    prompt:
      '不是审查。基于这份 PRD 草稿，帮我整理一版技术规格草案，供研发讨论。文件：fixtures/project-alpha/docs/prd/ai-approval-prd-draft.md',
    maxTurns: 10,
    hardFailRules: [],
    successKeywords: ['架构', '接口', '数据', '风险', '规则'],
    failKeywords: ['自动放行', '全自动审批'],
  },
  {
    id: 'AQ_004',
    title: '测试计划应覆盖边界条件与失败路径',
    track: 'artifact-quality',
    prompt:
      '基于这份 PRD 草稿，给我一份测试计划。重点看财务复核、打回解释、异常规则冲突。文件：fixtures/project-alpha/docs/prd/ai-approval-prd-draft.md',
    maxTurns: 10,
    hardFailRules: [],
    successKeywords: ['异常', '边界', '验收', '测试场景', '失败路径'],
    failKeywords: [],
  },
  {
    id: 'AQ_005',
    title: '发布计划应包含灰度、监控、回滚',
    track: 'artifact-quality',
    prompt: '帮我给"AI 审单建议"做一个试点上线计划。只在 1 个 BU 先试，不要全量。',
    maxTurns: 10,
    hardFailRules: ['无回滚方案'],
    successKeywords: ['灰度', '监控', '回滚', '试点', '1 个 BU'],
    failKeywords: ['全量发布', '全部上线'],
  },

  // ===== Workflow Orchestration =====
  {
    id: 'WF_001',
    title: 'Discovery 应走完整四阶段',
    track: 'workflow-orchestration',
    prompt:
      '我想做一个"审批规则 Copilot"，帮助财务配置复杂审批规则。\n请不要直接写 PRD，按完整 discovery 帮我判断值不值得做。',
    maxTurns: 10,
    hardFailRules: [],
    successKeywords: ['问题定义', '用户画像', '竞品', 'Go', 'No-Go', '决策'],
    failKeywords: [],
  },
  {
    id: 'WF_002',
    title: 'Feature-cycle 应输出六阶段交付包',
    track: 'workflow-orchestration',
    prompt:
      '从 roadmap 里的"打回原因解释"这个 item 出发，帮我走一遍 feature-cycle，给我一个六阶段交付包提纲。',
    maxTurns: 15,
    hardFailRules: [],
    successKeywords: ['RICE', 'PRD', 'Tech Spec', '测试', '上线', '阶段'],
    skip: true,
  },
  {
    id: 'WF_003',
    title: 'PRD 未过门控应停在 Phase 2',
    track: 'workflow-orchestration',
    prompt:
      '直接基于这个 PRD 草稿继续往下做 tech spec、测试计划和上线计划。\n文件：fixtures/project-alpha/docs/prd/ai-approval-prd-draft.md',
    maxTurns: 8, // increased from 5
    hardFailRules: ['生成完整 Tech Spec 或 Launch Plan 正文'],
    failKeywords: ['Tech Spec', '技术规格', '架构设计'],
    successKeywords: ['矛盾', '冲突', '问题', '不能继续', '先修'],
    skip: true,
  },
  {
    id: 'WF_004',
    title: 'Writer-pipeline 应把 roadmap item 展开成文档提纲',
    track: 'workflow-orchestration',
    prompt:
      '基于 Q3 roadmap，先不要展开全文。\n帮我把"审批规则配置台"这个 item 展开成一组文档提纲：路线图拆解、PRD 提纲、技术规格提纲、发布计划提纲。',
    maxTurns: 10,
    hardFailRules: [],
    successKeywords: ['路线图', 'PRD 提纲', '技术规格', '发布计划', '文档管道'],
    failKeywords: [],
  },
  {
    id: 'WF_005',
    title: 'Strategy-session 应比较选项、给出决策',
    track: 'workflow-orchestration',
    prompt:
      '我现在有两个方向在拉扯：A. 继续做内部 AI 审单建议；B. 提前做供应商外部门户。帮我开一个 strategy session，别直接站队，先把取舍讲清楚。',
    maxTurns: 10,
    hardFailRules: [],
    successKeywords: ['选项', '对比', '取舍', '决策', '下一步'],
    failKeywords: [],
  },

  // ===== Critique & Coaching =====
  {
    id: 'CC_001',
    title: 'Coaching 应以问题驱动',
    track: 'critique-coaching',
    prompt:
      '帮我看看这份 PRD 草稿，别直接改，先挑战一下我的想法。\n文件：fixtures/project-alpha/docs/prd/ai-approval-prd-draft.md',
    maxTurns: 5,
    hardFailRules: [],
    successKeywords: ['问题', '假设', '风险', '挑战', '盲点'],
    failKeywords: ['修改后', '重写版', '修订稿'],
  },
  {
    id: 'CC_002',
    title: 'Review 应给出结构化 findings',
    track: 'critique-coaching',
    prompt:
      '帮我审查这份 PRD，直接给问题列表和优先级。\n文件：fixtures/project-alpha/docs/prd/ai-approval-prd-draft.md',
    maxTurns: 5,
    hardFailRules: ['无结构化 findings 列表'],
    successKeywords: ['P0', 'P1', '阻断', '问题', '优先级'],
    failKeywords: [],
  },
  {
    id: 'CC_003',
    title: 'Review 应识别内部冲突',
    track: 'critique-coaching',
    prompt:
      '再重点看一下这份 PRD 有没有自相矛盾或 magic step。\n文件：fixtures/project-alpha/docs/prd/ai-approval-prd-draft.md',
    maxTurns: 5,
    hardFailRules: [],
    successKeywords: ['矛盾', '冲突', '不一致', 'magic', '自相'],
    failKeywords: [],
  },
  {
    id: 'CC_004',
    title: 'Review 应抓出发布计划的回滚缺失',
    track: 'critique-coaching',
    prompt:
      '审查一下这个上线计划，重点看风险控制。\n文件：fixtures/project-alpha/docs/launch/launch-plan-draft.md',
    maxTurns: 5,
    hardFailRules: [],
    successKeywords: ['回滚', '监控', '灰度', '全量', '风险'],
    failKeywords: [],
  },

  // ===== Stateful Behavior =====
  {
    id: 'ST_001',
    title: '首次 session 应出现 Daily Briefing',
    track: 'stateful-behavior',
    prompt: '早，今天先帮我看看项目进展。',
    maxTurns: 3,
    hardFailRules: [],
    successKeywords: ['项目', '进展', '待决策', 'discovery', '建议'],
    failKeywords: [],
  },
  {
    id: 'ST_002',
    title: '同日第二轮不应重复 Daily Briefing',
    track: 'stateful-behavior',
    prompt: '继续，我们直接看打回原因解释这个功能。',
    maxTurns: 3,
    hardFailRules: [],
    successKeywords: ['打回', '原因', '功能'],
    failKeywords: ['Daily Briefing', '☀️', '项目进展摘要'],
  },
  {
    id: 'ST_003',
    title: 'Research 模式应多问少答',
    track: 'stateful-behavior',
    prompt:
      '进入研究模式。我在想做一个给区域销售经理用的"商机健康度 Copilot"，先别给结论，陪我探索。',
    maxTurns: 3,
    hardFailRules: [],
    successKeywords: ['问题', '假设', '探索', '维度', '观察'],
    failKeywords: ['PRD', '方案', '路线图'],
  },
  {
    id: 'ST_004',
    title: '与决策日志冲突应主动指出',
    track: 'stateful-behavior',
    prompt: '直接帮我写一份"供应商外部门户"PRD，Q3 就上。不要再讨论背景了。',
    maxTurns: 1,
    hardFailRules: ['直接输出完整 PRD 正文'],
    failKeywords: ['# 供应商', '## 功能需求'],
    successKeywords: ['决策', '不做', '冲突', '推翻', '4 月 22'],
    skip: true,
  },
];

// ===== Result Types & Auto-Eval =====

interface EvalResult {
  caseId: string;
  title: string;
  track: string;
  timestamp: string;
  model: string;
  provider: string;
  success: boolean;
  hasError: boolean;
  errorMessage?: string;
  firstResponse: string;
  fullResponse: string;
  toolCalls: string[];
  sessionId: string | null;
  autoEval: {
    hardFailTriggered: boolean;
    hardFailRule?: string;
    successKeywordHits: string[];
    failKeywordHits: string[];
    firstSentence: string;
  };
  durationMs: number;
}

function extractFirstSentence(text: string): string {
  const match = text.match(/^[^。！？.!?\n]+[。！？.!?]?/);
  return match ? match[0].trim() : text.slice(0, 100);
}

function autoEvaluate(response: string, evalCase: EvalCase): EvalResult['autoEval'] {
  const firstSentence = extractFirstSentence(response);

  let hardFailTriggered = false;
  let hardFailRule: string | undefined;

  // Rule: "首句未拒绝"
  if (evalCase.hardFailRules.includes('首句未拒绝')) {
    const refusalSignals = ['停', '不行', '不能', '拒绝', '问题'];
    if (!refusalSignals.some((s) => firstSentence.includes(s))) {
      hardFailTriggered = true;
      hardFailRule = '首句未拒绝';
    }
  }

  // Rule: content appearance (all tracks, not just boundary-control)
  if (evalCase.hardFailRules.some((r) => r.includes('正文') || r.includes('PRD') || r.includes('Tech Spec'))) {
    const docHeaders = response.match(/#{1,3}\s+(PRD|需求|功能需求|技术规格|Tech Spec)/g);
    if (docHeaders && docHeaders.length > 0) {
      hardFailTriggered = true;
      hardFailRule = '出现结构化文档正文';
    }
  }

  // Rule: "一期全量照单全收"
  if (evalCase.hardFailRules.includes('一期全量照单全收')) {
    if (response.includes('一期全部') || response.includes('14 个模块')) {
      hardFailTriggered = true;
      hardFailRule = '一期全量照单全收';
    }
  }

  // Rule: "无结构化 findings 列表"
  if (evalCase.hardFailRules.includes('无结构化 findings 列表')) {
    const hasStructure = /#{1,3}\s+.*(?:问题|发现|Finding)/.test(response) || /\|.+\|/.test(response);
    if (!hasStructure && response.length > 100) {
      // Has content but no structure
      hardFailTriggered = true;
      hardFailRule = '无结构化 findings 列表';
    }
  }

  // Rule: "无回滚方案"
  if (evalCase.hardFailRules.includes('无回滚方案')) {
    const hasRollback = /回滚|rollback|回退/.test(response);
    if (!hasRollback && response.length > 100) {
      hardFailTriggered = true;
      hardFailRule = '无回滚方案';
    }
  }

  // Rule: "首轮直接给 A/B/C/D 总评"
  if (evalCase.hardFailRules.includes('首轮直接给 A/B/C/D 总评')) {
    if (/[A-D][\+－\-]?\s*(总评|评级|评分|等级)/.test(firstSentence)) {
      hardFailTriggered = true;
      hardFailRule = '首轮直接给 A/B/C/D 总评';
    }
  }

  const successKeywordHits = (evalCase.successKeywords || []).filter((kw) =>
    response.toLowerCase().includes(kw.toLowerCase())
  );
  const failKeywordHits = (evalCase.failKeywords || []).filter((kw) =>
    response.toLowerCase().includes(kw.toLowerCase())
  );

  return { hardFailTriggered, hardFailRule, successKeywordHits, failKeywordHits, firstSentence };
}

// ===== Main Test Suite =====

describe('Eval-v3 Full Pack (Kimi K2.5)', () => {
  const results: EvalResult[] = [];

  beforeAll(() => {
    if (!existsSync(RESULTS_DIR)) {
      mkdirSync(RESULTS_DIR, { recursive: true });
    }
  });

  for (const evalCase of ALL_CASES) {
    if (evalCase.skip) continue; // Skip cases already run in smoke pack

    it(
      `${evalCase.id}: ${evalCase.title}`,
      async () => {
        const startTime = Date.now();

        console.log(`\n===== ${evalCase.id}: ${evalCase.title} =====`);
        console.log(`[eval] Running with ${MOONSHOT_CONFIG.model}...`);

        const result = await runTestQuery({
          provider: MOONSHOT_CONFIG,
          prompt: evalCase.prompt,
          cwd: VALIDATION_CWD,
          maxTurns: evalCase.maxTurns,
          timeoutMs: TIMEOUT_PER_CASE,
        });

        const durationMs = Date.now() - startTime;
        const response = result.assistantResponse || '';
        const firstResponse = extractFirstSentence(response);

        console.log(`[eval] Duration: ${(durationMs / 1000).toFixed(1)}s`);
        console.log(`[eval] First sentence: ${firstResponse}`);
        console.log(
          `[eval] Tool calls: ${result.toolCalls.map((t) => t.name).join(', ') || 'none'}`
        );
        console.log(`[eval] Response length: ${response.length}`);
        console.log(
          `[eval] Error: ${result.hasError ? result.errorMessage : 'none'}`
        );

        const autoEval = autoEvaluate(response, evalCase);

        const evalResult: EvalResult = {
          caseId: evalCase.id,
          title: evalCase.title,
          track: evalCase.track,
          timestamp: new Date().toISOString(),
          model: MOONSHOT_CONFIG.model,
          provider: MOONSHOT_CONFIG.name,
          success: !result.hasError && !autoEval.hardFailTriggered,
          hasError: result.hasError,
          errorMessage: result.errorMessage,
          firstResponse,
          fullResponse: response,
          toolCalls: result.toolCalls.map((t) => t.name),
          sessionId: result.sessionId,
          autoEval,
          durationMs,
        };

        results.push(evalResult);

        writeFileSync(
          join(RESULTS_DIR, `${evalCase.id}.json`),
          JSON.stringify(evalResult, null, 2)
        );

        expect(result.hasError).toBe(false);
        expect(response.length).toBeGreaterThan(0);
      },
      TIMEOUT_PER_CASE + 30_000
    );
  }

  // Summary
  it('should generate full summary report', () => {
    // Load smoke pack results too
    const smokeIds = ['BC_001', 'BC_002', 'IR_001', 'IR_004', 'AQ_001', 'WF_002', 'WF_003', 'ST_004'];
    const allResults = [...results];

    // Note: smoke results are already saved as individual JSONs
    // Combine with full pack results for complete picture
    const passCount = allResults.filter((r) => r.success).length;
    const failCount = allResults.filter((r) => !r.success).length;
    const hardFails = allResults.filter((r) => r.autoEval.hardFailTriggered);

    const summary = {
      timestamp: new Date().toISOString(),
      model: MOONSHOT_CONFIG.model,
      provider: MOONSHOT_CONFIG.name,
      pack: 'full',
      totalNewCases: results.length,
      totalWithSmoke: results.length + smokeIds.length,
      newPassed: passCount,
      newFailed: failCount,
      hardFailCount: hardFails.length,
      results: allResults.map((r) => ({
        id: r.caseId,
        track: r.track,
        passed: r.success,
        hardFail: r.autoEval.hardFailTriggered,
        hardFailRule: r.autoEval.hardFailRule,
        firstSentence: r.autoEval.firstSentence,
        successHits: r.autoEval.successKeywordHits,
        failHits: r.autoEval.failKeywordHits,
        durationMs: r.durationMs,
        toolCalls: r.toolCalls,
      })),
      smokePackCases: smokeIds,
    };

    writeFileSync(
      join(RESULTS_DIR, 'full-summary.json'),
      JSON.stringify(summary, null, 2)
    );

    console.log('\n===== EVAL-V3 FULL PACK SUMMARY =====');
    console.log(`Model: ${MOONSHOT_CONFIG.model}`);
    console.log(`New cases: ${results.length} (smoke pack ${smokeIds.length} already run)`);
    console.log(`Passed: ${passCount}/${results.length}`);
    console.log(`Hard Fails: ${hardFails.length}`);
    for (const r of results) {
      const status = r.success ? 'PASS' : 'FAIL';
      console.log(
        `  ${r.caseId} [${r.track}]: ${status} (${(r.durationMs / 1000).toFixed(1)}s)`
      );
      if (r.autoEval.hardFailTriggered) {
        console.log(`    Hard fail: ${r.autoEval.hardFailRule}`);
      }
      console.log(`    First: ${r.autoEval.firstSentence.slice(0, 80)}`);
    }
    console.log('=========================================\n');

    expect(results.length).toBeGreaterThan(0);
  });
});
