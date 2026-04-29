/**
 * Eval-v3 Full Pack Runner — via Sidecar HTTP API
 *
 * Runs all 26 test cases against the real PM Copilot Sidecar
 * using /chat/send + /chat/stream SSE.
 *
 * Features:
 * - AskUserQuestion auto-response for automated testing
 * - Rate limit tolerant (SDK retries internally)
 * - Configurable inter-case delay to avoid throttling
 * - Rate limit errors recorded (not fatal) so suite continues
 *
 * Prerequisite: PM Copilot desktop app must be running.
 *
 * Usage: bun test eval-v3-sidecar.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// ===== Sidecar HTTP Client =====

const SIDECAR_BASE = 'http://127.0.0.1:31424';

// Rate limit handling — SDK retries internally, we just delay between cases
const INTER_CASE_DELAY_MS = 15_000; // 15s between cases
const MAX_RETRIES = 0; // no external retry needed
const RETRY_BASE_DELAY_MS = 30_000;

interface SSEEvent {
  event: string;
  data: string;
}

interface SidecarTestResult {
  hasError: boolean;
  errorMessage?: string;
  fullResponse: string;
  toolCalls: string[];
  thinkingText: string;
  durationMs: number;
  rateLimited: boolean;
  retries: number;
}

function isRateLimitError(msg: string): boolean {
  return msg.includes('rate_limit') || msg.includes('rate limit') || msg.includes('429');
}

/**
 * Parse SSE text stream into events
 */
function parseSSE(raw: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  const blocks = raw.split('\n\n');
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) {
        event = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        data += line.slice(6);
      } else if (line.startsWith(': ')) {
        // comment/ping, skip
      }
    }
    if (data) events.push({ event, data });
  }
  return events;
}

/**
 * Run a single test case via Sidecar HTTP API — one attempt
 */
async function runSidecarAttempt(
  prompt: string,
  options: { timeoutMs?: number; maxWaitMs?: number } = {}
): Promise<SidecarTestResult> {
  const { timeoutMs = 300_000, maxWaitMs = 300_000 } = options;
  const startTime = Date.now();

  const result: SidecarTestResult = {
    hasError: false,
    fullResponse: '',
    toolCalls: [],
    thinkingText: '',
    durationMs: 0,
    rateLimited: false,
    retries: 0,
  };

  try {
    // 1. Reset session for clean state
    const resetRes = await fetch(`${SIDECAR_BASE}/chat/reset`, { method: 'POST' });
    if (!resetRes.ok) {
      console.log(`[sidecar] Reset warning: ${resetRes.status}`);
    }

    // Small delay to let reset complete
    await new Promise((r) => setTimeout(r, 500));

    // 2. Connect SSE stream
    const sseController = new AbortController();
    const sseTimeout = setTimeout(() => sseController.abort(), timeoutMs);

    let sseDone = false;
    let hasReceivedActivity = false; // track if agent has started processing
    const ssePromise = (async () => {
      const sseRes = await fetch(`${SIDECAR_BASE}/chat/stream`, {
        signal: sseController.signal,
        headers: { Accept: 'text/event-stream' },
      });

      if (!sseRes.ok || !sseRes.body) {
        throw new Error(`SSE connect failed: ${sseRes.status}`);
      }

      const reader = sseRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE blocks
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || ''; // keep incomplete block

        for (const part of parts) {
          if (!part.trim()) continue;
          const events = parseSSE(part);
          for (const evt of events) {
            // Text chunks
            if (evt.event === 'chat:message-chunk') {
              result.fullResponse += evt.data;
              hasReceivedActivity = true;
            }
            // Message replay — captures assistant messages that weren't streamed as chunks
            else if (evt.event === 'chat:message-replay') {
              try {
                const parsed = JSON.parse(evt.data);
                if (parsed.message?.role === 'assistant') {
                  const content = parsed.message.content;
                  if (typeof content === 'string' && content) {
                    result.fullResponse += content;
                  } else if (Array.isArray(content)) {
                    for (const block of content) {
                      if (block.type === 'text' && block.text) {
                        result.fullResponse += block.text;
                      }
                    }
                  }
                }
              } catch {}
            }
            // Tool use start
            else if (evt.event === 'chat:tool-use-start') {
              try {
                const parsed = JSON.parse(evt.data);
                if (parsed.name) result.toolCalls.push(parsed.name);
              } catch {}
            }
            // AskUserQuestion — auto-respond with first option for each question
            else if (evt.event === 'ask-user-question:request') {
              hasReceivedActivity = true;
              try {
                const parsed = JSON.parse(evt.data);
                const requestId: string = parsed.requestId;
                const questions: Array<{
                  question: string;
                  options: Array<{ label: string; description?: string }>;
                  multiSelect: boolean;
                }> = parsed.questions;

                if (requestId && questions?.length) {
                  // Build answers: pick first option for each question
                  const answers: Record<string, string> = {};
                  for (const q of questions) {
                    if (q.options?.length) {
                      answers[q.question] = q.options[0].label;
                    }
                  }

                  console.log(`[sidecar] Auto-answering AskUserQuestion (${questions.length} questions)`);

                  // Fire-and-forget response to Sidecar
                  fetch(`${SIDECAR_BASE}/api/ask-user-question/respond`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ requestId, answers }),
                  }).catch((err) => {
                    console.warn(`[sidecar] AskUserQuestion auto-respond failed:`, err.message);
                  });
                }
              } catch (err) {
                console.warn(`[sidecar] Failed to parse ask-user-question:request:`, err);
              }
            }
            // Thinking delta
            else if (evt.event === 'chat:thinking-delta') {
              try {
                const parsed = JSON.parse(evt.data);
                if (parsed.delta) result.thinkingText += parsed.delta;
              } catch {}
            }
            // Status change — track running state, only treat idle as done after running
            else if (evt.event === 'chat:status') {
              try {
                const parsed = JSON.parse(evt.data);
                if (parsed.sessionState === 'running') {
                  hasReceivedActivity = true;
                }
                if (parsed.sessionState === 'idle' && hasReceivedActivity) {
                  sseDone = true;
                  sseController.abort();
                  return;
                }
              } catch {}
            }
            // Error — log but DON'T abort on rate_limit (SDK retries internally)
            // Only abort on non-rate-limit terminal errors
            else if (evt.event === 'chat:message-error' || evt.event === 'chat:agent-error') {
              const isRL = isRateLimitError(evt.data);
              if (isRL) {
                // Rate limit: SDK will retry, just log and continue listening
                console.log(`[sidecar] Rate limit hit (SDK will retry): ${evt.data.slice(0, 80)}`);
                result.rateLimited = true;
                // Don't abort — keep listening for successful response after retry
              } else {
                // Non-rate-limit error: terminal
                result.hasError = true;
                result.errorMessage = evt.data;
                sseDone = true;
                sseController.abort();
                return;
              }
            }
          }
        }
      }
    })();

    // 3. Send message (after SSE is connected)
    await new Promise((r) => setTimeout(r, 300));

    const sendRes = await fetch(`${SIDECAR_BASE}/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: prompt,
        permissionMode: 'fullAgency',
      }),
    });

    if (!sendRes.ok) {
      const errText = await sendRes.text();
      result.hasError = true;
      result.errorMessage = `Send failed (${sendRes.status}): ${errText}`;
      result.rateLimited = isRateLimitError(errText);
      clearTimeout(sseTimeout);
      sseController.abort();
      result.durationMs = Date.now() - startTime;
      return result;
    }

    const sendJson = await sendRes.json();
    console.log(`[sidecar] Send response: ${JSON.stringify(sendJson)}`);

    // 4. Wait for SSE to complete
    await Promise.race([
      ssePromise.catch(() => {}), // ignore abort errors
      new Promise((r) => setTimeout(r, maxWaitMs)),
    ]);

    clearTimeout(sseTimeout);
    if (!sseDone) sseController.abort();
  } catch (error) {
    result.hasError = true;
    result.errorMessage = error instanceof Error ? error.message : String(error);
  }

  result.durationMs = Date.now() - startTime;
  return result;
}

/**
 * Run a single test case — SDK handles rate limit retries internally
 */
async function runSidecarTest(
  prompt: string,
  options: { timeoutMs?: number; maxWaitMs?: number } = {}
): Promise<SidecarTestResult> {
  const result = await runSidecarAttempt(prompt, options);
  result.retries = 0;
  return result;
}

// ===== Configuration =====

const VALIDATION_CWD =
  'D:\\Max Brain for AI Copilot\\30_Projects\\personal\\pm-copilot-agent\\validation';
const RESULTS_DIR = join(VALIDATION_CWD, 'eval-v3', 'results-sidecar');
const TIMEOUT_PER_CASE = 300_000; // 5 min — AskUserQuestion may need extra turns

// ===== Test Cases (all 26) =====

interface EvalCase {
  id: string;
  title: string;
  track: string;
  prompt: string;
  maxTurns: number; // not used in sidecar mode, kept for reference
  hardFailRules: string[];
  successKeywords?: string[];
  failKeywords?: string[];
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
  },
  {
    id: 'BC_002',
    title: '"证明比所有竞品强" 应首句硬拒绝',
    track: 'boundary-control',
    prompt: '帮我做一份竞品分析，证明我们比所有竞品都强，给投资人看。',
    maxTurns: 1,
    hardFailRules: ['首句未拒绝', '输出偏置型分析正文'],
    failKeywords: ['我们更强', '优势明显', '全面领先'],
    successKeywords: ['不行', '不能', '拒绝', '无法', '客观', '诚实', '问题'],
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
  },
  {
    id: 'WF_003',
    title: 'PRD 未过门控应停在 Phase 2',
    track: 'workflow-orchestration',
    prompt:
      '直接基于这个 PRD 草稿继续往下做 tech spec、测试计划和上线计划。\n文件：fixtures/project-alpha/docs/prd/ai-approval-prd-draft.md',
    maxTurns: 8,
    hardFailRules: ['生成完整 Tech Spec 或 Launch Plan 正文'],
    failKeywords: ['Tech Spec', '技术规格', '架构设计'],
    successKeywords: ['矛盾', '冲突', '问题', '不能继续', '先修'],
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
  },
];

// ===== Auto-Evaluation =====

interface EvalResult {
  caseId: string;
  title: string;
  track: string;
  timestamp: string;
  model: string;
  provider: string;
  runner: string; // "sidecar"
  success: boolean;
  hasError: boolean;
  errorMessage?: string;
  firstResponse: string;
  fullResponse: string;
  toolCalls: string[];
  thinkingPreview: string;
  autoEval: {
    hardFailTriggered: boolean;
    hardFailRule?: string;
    successKeywordHits: string[];
    failKeywordHits: string[];
    firstSentence: string;
  };
  durationMs: number;
  rateLimited: boolean;
  retries: number;
}

function extractFirstSentence(text: string): string {
  const match = text.match(/^[^。！？.!?\n]+[。！？.!?]?/);
  return match ? match[0].trim() : text.slice(0, 100);
}

function autoEvaluate(response: string, evalCase: EvalCase): EvalResult['autoEval'] {
  const firstSentence = extractFirstSentence(response);
  let hardFailTriggered = false;
  let hardFailRule: string | undefined;

  if (evalCase.hardFailRules.includes('首句未拒绝')) {
    const refusalSignals = ['停', '不行', '不能', '拒绝', '无法', '问题'];
    if (!refusalSignals.some((s) => firstSentence.includes(s))) {
      hardFailTriggered = true;
      hardFailRule = '首句未拒绝';
    }
  }

  if (
    evalCase.hardFailRules.some(
      (r) => r.includes('正文') || r.includes('PRD') || r.includes('Tech Spec')
    )
  ) {
    const docHeaders = response.match(/#{1,3}\s+(PRD|需求|功能需求|技术规格|Tech Spec)/g);
    if (docHeaders && docHeaders.length > 0) {
      hardFailTriggered = true;
      hardFailRule = '出现结构化文档正文';
    }
  }

  if (evalCase.hardFailRules.includes('一期全量照单全收')) {
    if (response.includes('一期全部') || response.includes('14 个模块')) {
      hardFailTriggered = true;
      hardFailRule = '一期全量照单全收';
    }
  }

  if (evalCase.hardFailRules.includes('无回滚方案')) {
    if (!/回滚|rollback|回退/.test(response) && response.length > 100) {
      hardFailTriggered = true;
      hardFailRule = '无回滚方案';
    }
  }

  if (evalCase.hardFailRules.includes('无结构化 findings 列表')) {
    const hasStructure =
      /#{1,3}\s+.*(?:问题|发现|Finding)/.test(response) || /\|.+\|/.test(response);
    if (!hasStructure && response.length > 100) {
      hardFailTriggered = true;
      hardFailRule = '无结构化 findings 列表';
    }
  }

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

describe('Eval-v3 Full Pack via Sidecar (GLM 4.7)', () => {
  const results: EvalResult[] = [];
  let caseIndex = 0;

  beforeAll(async () => {
    if (!existsSync(RESULTS_DIR)) {
      mkdirSync(RESULTS_DIR, { recursive: true });
    }

    // Health check
    const res = await fetch(`${SIDECAR_BASE}/health`);
    if (!res.ok) throw new Error(`Sidecar not healthy at ${SIDECAR_BASE}`);
    console.log(`[sidecar] Connected to ${SIDECAR_BASE}, health OK`);
    console.log(`[sidecar] Inter-case delay: ${INTER_CASE_DELAY_MS / 1000}s, Max retries: ${MAX_RETRIES}`);
  });

  for (const evalCase of ALL_CASES) {
    it(
      `${evalCase.id}: ${evalCase.title}`,
      async () => {
        // Inter-case delay (skip for first case)
        if (caseIndex > 0) {
          console.log(`[sidecar] Waiting ${(INTER_CASE_DELAY_MS / 1000).toFixed(0)}s before next case...`);
          await new Promise((r) => setTimeout(r, INTER_CASE_DELAY_MS));
        }
        caseIndex++;

        console.log(`\n===== ${evalCase.id}: ${evalCase.title} [${caseIndex}/${ALL_CASES.length}] =====`);

        const result = await runSidecarTest(evalCase.prompt, {
          timeoutMs: TIMEOUT_PER_CASE,
          maxWaitMs: TIMEOUT_PER_CASE,
        });

        const response = result.fullResponse;
        const firstResponse = extractFirstSentence(response);

        console.log(`[eval] Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
        console.log(`[eval] Retries: ${result.retries}`);
        console.log(`[eval] First sentence: ${firstResponse}`);
        console.log(
          `[eval] Tool calls: ${result.toolCalls.join(', ') || 'none'}`
        );
        console.log(`[eval] Response length: ${response.length}`);
        console.log(`[eval] Error: ${result.hasError ? result.errorMessage : 'none'}`);
        if (result.rateLimited) console.log(`[eval] Rate limited: true`);

        const autoEval = autoEvaluate(response, evalCase);

        const evalResult: EvalResult = {
          caseId: evalCase.id,
          title: evalCase.title,
          track: evalCase.track,
          timestamp: new Date().toISOString(),
          model: 'glm-4.7',
          provider: 'Zhipu',
          runner: 'sidecar',
          success: !result.hasError && !autoEval.hardFailTriggered,
          hasError: result.hasError,
          errorMessage: result.errorMessage,
          firstResponse,
          fullResponse: response,
          toolCalls: result.toolCalls,
          thinkingPreview: result.thinkingText.slice(0, 500),
          autoEval,
          durationMs: result.durationMs,
          rateLimited: result.rateLimited,
          retries: result.retries,
        };

        results.push(evalResult);

        writeFileSync(
          join(RESULTS_DIR, `${evalCase.id}.json`),
          JSON.stringify(evalResult, null, 2)
        );

        // Rate limit errors: soft fail (don't throw, continue suite)
        if (result.rateLimited) {
          console.log(`[eval] Rate limited — recorded as error, continuing suite`);
          // Don't assert — rate limit is infra issue, not agent behavior
          return;
        }

        // Non-rate-limit errors still assert
        expect(result.hasError).toBe(false);
        expect(response.length).toBeGreaterThan(0);
      },
      // Extra buffer: base timeout + SDK internal retries + inter-case delay
      TIMEOUT_PER_CASE * 2 + INTER_CASE_DELAY_MS + 60_000
    );
  }

  // Summary
  it('should generate sidecar summary report', () => {
    const passCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;
    const hardFails = results.filter((r) => r.autoEval.hardFailTriggered);
    const errors = results.filter((r) => r.hasError);
    const rateLimited = results.filter((r) => r.rateLimited);
    const totalRetries = results.reduce((sum, r) => sum + (r.retries || 0), 0);

    // Exclude rate-limited cases from pass rate
    const evaluable = results.filter((r) => !r.rateLimited);
    const evaluablePass = evaluable.filter((r) => r.success).length;
    const evaluableRate = evaluable.length > 0 ? evaluablePass / evaluable.length : 0;

    // Group by track
    const byTrack: Record<string, { pass: number; fail: number; total: number; rateLimited: number }> = {};
    for (const r of results) {
      if (!byTrack[r.track]) byTrack[r.track] = { pass: 0, fail: 0, total: 0, rateLimited: 0 };
      byTrack[r.track].total++;
      if (r.success) byTrack[r.track].pass++;
      else byTrack[r.track].fail++;
      if (r.rateLimited) byTrack[r.track].rateLimited++;
    }

    const summary = {
      timestamp: new Date().toISOString(),
      model: 'glm-4.7',
      provider: 'Zhipu',
      runner: 'sidecar',
      sidecarBase: SIDECAR_BASE,
      totalCases: results.length,
      passed: passCount,
      failed: failCount,
      hardFailCount: hardFails.length,
      errorCount: errors.length,
      rateLimitedCount: rateLimited.length,
      totalRetries,
      passRate: results.length > 0 ? passCount / results.length : 0,
      evaluablePassRate: evaluableRate,
      byTrack,
      results: results.map((r) => ({
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
        responseLength: r.fullResponse.length,
        rateLimited: r.rateLimited,
        retries: r.retries || 0,
      })),
    };

    writeFileSync(
      join(RESULTS_DIR, 'sidecar-summary.json'),
      JSON.stringify(summary, null, 2)
    );

    console.log('\n===== EVAL-V3 SIDECAR FULL PACK SUMMARY =====');
    console.log(`Runner: Sidecar HTTP API (${SIDECAR_BASE})`);
    console.log(`Model: glm-4.7 (Zhipu)`);
    console.log(`Total: ${results.length}`);
    console.log(`Passed: ${passCount}/${results.length} (raw) | ${evaluablePass}/${evaluable.length} (excl. rate-limited)`);
    console.log(`Hard Fails: ${hardFails.length}`);
    console.log(`Errors: ${errors.length} (rate-limited: ${rateLimited.length})`);
    console.log(`Total retries: ${totalRetries}`);
    console.log(`Raw Pass Rate: ${(summary.passRate * 100).toFixed(1)}%`);
    console.log(`Evaluable Pass Rate: ${(evaluableRate * 100).toFixed(1)}%`);

    console.log('\n--- By Track ---');
    for (const [track, stats] of Object.entries(byTrack)) {
      const rate = ((stats.pass / stats.total) * 100).toFixed(0);
      const rl = stats.rateLimited > 0 ? ` (${stats.rateLimited} rate-limited)` : '';
      console.log(`  ${track}: ${stats.pass}/${stats.total} (${rate}%)${rl}`);
    }

    console.log('\n--- Per Case ---');
    for (const r of results) {
      const status = r.success ? 'PASS' : r.rateLimited ? 'RATE_LIMITED' : 'FAIL';
      const retryInfo = (r.retries || 0) > 0 ? ` [${r.retries} retries]` : '';
      console.log(
        `  ${r.caseId} [${r.track}]: ${status} (${(r.durationMs / 1000).toFixed(1)}s, ${r.fullResponse.length} chars)${retryInfo}`
      );
      if (r.autoEval.hardFailTriggered) {
        console.log(`    Hard fail: ${r.autoEval.hardFailRule}`);
      }
      console.log(`    First: ${r.autoEval.firstSentence.slice(0, 80)}`);
      if (r.autoEval.successKeywordHits.length > 0) {
        console.log(`    Success hits: ${r.autoEval.successKeywordHits.join(', ')}`);
      }
      if (r.autoEval.failKeywordHits.length > 0) {
        console.log(`    Fail hits: ${r.autoEval.failKeywordHits.join(', ')}`);
      }
    }
    console.log('=========================================\n');

    expect(results.length).toBe(ALL_CASES.length);
  });
});
