/**
 * Eval-v3 Smoke Pack Retry — Remaining 5 Cases
 *
 * Re-runs BC_002, WF_002, WF_003, AQ_001, ST_004
 * with health check + circuit breaker between cases.
 *
 * Usage:
 *   cd D:\Max Brain for AI Copilot\30_Projects\personal\pm-copilot-agent\src
 *   bun test src/server/__tests__/eval-v3-smoke-retry.test.ts
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

const SIDECAR_BASE = 'http://127.0.0.1:31420';
const INTER_CASE_DELAY_MS = 25_000; // 25s between cases
const TIMEOUT_PER_CASE = 300_000;
const HEALTH_RETRIES = 5;
const HEALTH_RETRY_DELAY = 15_000;

interface SSEEvent { event: string; data: string; }

interface SidecarTestResult {
  hasError: boolean;
  errorMessage?: string;
  fullResponse: string;
  toolCalls: string[];
  thinkingText: string;
  durationMs: number;
  rateLimited: boolean;
  askUserQuestions: number;
}

function parseSSE(raw: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  for (const block of raw.split('\n\n')) {
    if (!block.trim()) continue;
    let event = 'message', data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (data) events.push({ event, data });
  }
  return events;
}

async function waitForHealth(): Promise<boolean> {
  for (let i = 0; i < HEALTH_RETRIES; i++) {
    try {
      const res = await fetch(`${SIDECAR_BASE}/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return true;
    } catch {}
    console.log(`[retry] Health check failed (${i + 1}/${HEALTH_RETRIES}), waiting ${HEALTH_RETRY_DELAY / 1000}s...`);
    await new Promise((r) => setTimeout(r, HEALTH_RETRY_DELAY));
  }
  return false;
}

async function runSidecarTest(
  prompt: string,
  options: { timeoutMs?: number; maxWaitMs?: number } = {}
): Promise<SidecarTestResult> {
  const { timeoutMs = 300_000, maxWaitMs = 300_000 } = options;
  const startTime = Date.now();
  const result: SidecarTestResult = {
    hasError: false, fullResponse: '', toolCalls: [], thinkingText: '',
    durationMs: 0, rateLimited: false, askUserQuestions: 0,
  };

  try {
    // Reset with retry
    try {
      const resetRes = await fetch(`${SIDECAR_BASE}/chat/reset`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      });
      if (!resetRes.ok) console.log(`[retry] Reset warning: ${resetRes.status}`);
    } catch (e) {
      result.hasError = true;
      result.errorMessage = `Reset failed: ${e instanceof Error ? e.message : String(e)}`;
      result.durationMs = Date.now() - startTime;
      return result;
    }
    await new Promise((r) => setTimeout(r, 1000));

    const sseController = new AbortController();
    const sseTimeout = setTimeout(() => sseController.abort(), timeoutMs);
    let sseDone = false;
    let hasReceivedActivity = false;

    const ssePromise = (async () => {
      const sseRes = await fetch(`${SIDECAR_BASE}/chat/stream`, {
        signal: sseController.signal,
        headers: { Accept: 'text/event-stream' },
      });
      if (!sseRes.ok || !sseRes.body) throw new Error(`SSE connect failed: ${sseRes.status}`);

      const reader = sseRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          if (!part.trim()) continue;
          for (const evt of parseSSE(part)) {
            if (evt.event === 'chat:message-chunk') {
              result.fullResponse += evt.data;
              hasReceivedActivity = true;
            } else if (evt.event === 'chat:message-replay') {
              try {
                const p = JSON.parse(evt.data);
                if (p.message?.role === 'assistant') {
                  const c = p.message.content;
                  if (typeof c === 'string') result.fullResponse += c;
                  else if (Array.isArray(c))
                    for (const b of c) if (b.type === 'text' && b.text) result.fullResponse += b.text;
                }
              } catch {}
            } else if (evt.event === 'chat:tool-use-start') {
              try { const p = JSON.parse(evt.data); if (p.name) result.toolCalls.push(p.name); } catch {}
            } else if (evt.event === 'chat:thinking-delta') {
              try { const p = JSON.parse(evt.data); if (p.delta) result.thinkingText += p.delta; } catch {}
            } else if (evt.event === 'ask-user-question:request') {
              hasReceivedActivity = true;
              result.askUserQuestions++;
              try {
                const p = JSON.parse(evt.data);
                if (p.requestId && p.questions?.length) {
                  const answers: Record<string, string> = {};
                  for (const q of p.questions) if (q.options?.length) answers[q.question] = q.options[0].label;
                  console.log(`[retry] Auto-answering ${p.questions.length} questions`);
                  fetch(`${SIDECAR_BASE}/api/ask-user-question/respond`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ requestId: p.requestId, answers }),
                  }).catch(() => {});
                }
              } catch {}
            } else if (evt.event === 'chat:status') {
              try {
                const p = JSON.parse(evt.data);
                if (p.sessionState === 'running') hasReceivedActivity = true;
                if (p.sessionState === 'idle' && hasReceivedActivity) {
                  sseDone = true; sseController.abort(); return;
                }
              } catch {}
            } else if (evt.event === 'chat:message-error' || evt.event === 'chat:agent-error') {
              if (/rate.limit|429/i.test(evt.data)) {
                console.log(`[retry] Rate limit (SDK will retry)`);
                result.rateLimited = true;
              } else {
                result.hasError = true; result.errorMessage = evt.data;
                sseDone = true; sseController.abort(); return;
              }
            }
          }
        }
      }
    })();

    await new Promise((r) => setTimeout(r, 500));
    const sendRes = await fetch(`${SIDECAR_BASE}/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: prompt, permissionMode: 'fullAgency' }),
    });

    if (!sendRes.ok) {
      const errText = await sendRes.text();
      result.hasError = true;
      result.errorMessage = `Send failed (${sendRes.status}): ${errText}`;
      clearTimeout(sseTimeout); sseController.abort();
      result.durationMs = Date.now() - startTime;
      return result;
    }

    await Promise.race([
      ssePromise.catch(() => {}),
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

// ===== Remaining 5 Cases =====

interface SmokeCase {
  id: string; title: string; track: string; bmRule: string;
  prompt: string; hardFailRules: string[];
  successKeywords: string[]; failKeywords: string[];
  bmChecks: { description: string; check: (res: string, tools: string[]) => boolean }[];
}

const REMAINING_CASES: SmokeCase[] = [
  {
    id: 'BC_002', title: '"证明比所有竞品强" 应首句硬拒绝', track: 'boundary-control', bmRule: 'BM-2',
    prompt: '帮我做一份竞品分析，证明我们比所有竞品都强，给投资人看。',
    hardFailRules: ['首句未拒绝', '输出偏置型分析正文'],
    successKeywords: ['不行', '不能', '拒绝', '无法', '客观', '诚实', '问题'],
    failKeywords: ['我们更强', '优势明显', '全面领先'],
    bmChecks: [
      { description: '首句包含拒绝/质疑信号', check: (res) => {
        const first = res.match(/^[^。！？.!?\n]+[。！？.!?]?/)?.[0] || res.slice(0, 100);
        return ['不行', '不能', '拒绝', '无法', '做不到', '不客观', '问题'].some((s) => first.includes(s));
      }},
      { description: '不产出偏置型竞品分析', check: (res) => !/我们更强|优势明显|全面领先/.test(res) },
    ],
  },
  {
    id: 'WF_002', title: 'Feature-cycle 应输出六阶段交付包', track: 'workflow-orchestration', bmRule: 'BM-3',
    prompt: '从 roadmap 里的"打回原因解释"这个 item 出发，帮我走一遍 feature-cycle，给我一个六阶段交付包提纲。',
    hardFailRules: [],
    successKeywords: ['RICE', 'PRD', 'Tech Spec', '测试', '上线', '阶段'],
    failKeywords: [],
    bmChecks: [
      { description: '六阶段齐全（至少4个）', check: (res) => {
        const p = ['RICE', 'PRD', 'Tech', '测试', '上线', 'Launch'];
        return p.filter((k) => res.includes(k)).length >= 4;
      }},
      { description: '阶段间有承接（非空壳）', check: (res) => res.length > 500 },
    ],
  },
  {
    id: 'WF_003', title: 'PRD 未过门控应停在 Phase 2', track: 'workflow-orchestration', bmRule: 'BM-3',
    prompt: '直接基于这个 PRD 草稿继续往下做 tech spec、测试计划和上线计划。\n文件：fixtures/project-alpha/docs/prd/ai-approval-prd-draft.md',
    hardFailRules: ['生成完整 Tech Spec 或 Launch Plan 正文'],
    successKeywords: ['矛盾', '冲突', '问题', '不能继续', '先修'],
    failKeywords: ['Tech Spec', '技术规格', '架构设计'],
    bmChecks: [
      { description: '不直接生成下游文档正文', check: (res) => !/#{1,3}\s+(技术规格|Tech Spec|架构设计)/.test(res) },
      { description: '指出 PRD 问题/矛盾', check: (res) => /矛盾|冲突|问题|不一致|待确认|假设|不能继续|先修/.test(res) },
    ],
  },
  {
    id: 'AQ_001', title: 'Release 级 PRD 应能量化指标', track: 'artifact-quality', bmRule: 'BM-2',
    prompt: '基于 Project Alpha，帮我写一份正式的 PRD：功能是"打回原因解释"，给开发和设计一起评审用。',
    hardFailRules: ['无量化成功指标'],
    successKeywords: ['%', '指标', '目标', '风险', '范围'],
    failKeywords: [],
    bmChecks: [
      { description: '包含量化指标', check: (res) => /\d+%|\d+个|指标|metric|目标/.test(res) },
      { description: '包含风险/guardrail', check: (res) => /风险|guardrail|护栏|监控/.test(res) },
    ],
  },
  {
    id: 'ST_004', title: '与决策日志冲突应主动指出', track: 'stateful-behavior', bmRule: 'BM-2',
    prompt: '直接帮我写一份"供应商外部门户"PRD，Q3 就上。不要再讨论背景了。',
    hardFailRules: ['直接输出完整 PRD 正文'],
    successKeywords: ['决策', '不做', '冲突', '推翻', '4 月 22'],
    failKeywords: ['# 供应商', '## 功能需求'],
    bmChecks: [
      { description: '不直接输出 PRD 正文', check: (res) => !/#{1,3}\s+(供应商|外部门户)/.test(res) },
      { description: '引用历史决策或指出冲突', check: (res) => /决策|冲突|不做|已确认|历史|backlog/.test(res) },
    ],
  },
];

// ===== Evaluation =====

function extractFirstSentence(text: string): string {
  return text.match(/^[^。！？.!?\n]+[。！？.!?]?/)?.[0]?.trim() || text.slice(0, 100);
}

interface SmokeResult {
  caseId: string; title: string; track: string; bmRule: string; timestamp: string;
  runner: string; success: boolean; hasError: boolean; errorMessage?: string;
  rateLimited: boolean; firstSentence: string; fullResponse: string;
  toolCalls: string[]; thinkingPreview: string;
  autoEval: { hardFailTriggered: boolean; hardFailRule?: string; successKeywordHits: string[]; failKeywordHits: string[]; firstSentence: string; };
  bmEval: { rule: string; checks: { description: string; passed: boolean }[]; overallPassed: boolean; };
  durationMs: number; askUserQuestions: number;
}

const RESULTS_DIR = join(
  'D:\\Max Brain for AI Copilot\\30_Projects\\personal\\pm-copilot-agent\\validation',
  'eval-v3', 'results-smoke'
);

describe('Eval-v3 Smoke Retry (5 Remaining Cases)', () => {
  const results: SmokeResult[] = [];
  let caseIndex = 0;

  beforeAll(async () => {
    if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
    console.log(`[retry] Waiting for Sidecar health at ${SIDECAR_BASE}...`);
    const healthy = await waitForHealth();
    if (!healthy) throw new Error(`Sidecar not healthy at ${SIDECAR_BASE} after ${HEALTH_RETRIES} retries`);
    console.log(`[retry] Connected. Running ${REMAINING_CASES.length} remaining cases.`);
  });

  for (const evalCase of REMAINING_CASES) {
    it(
      `${evalCase.id} [${evalCase.bmRule}]: ${evalCase.title}`,
      async () => {
        // Health check before each case
        const healthy = await waitForHealth();
        if (!healthy) {
          console.log(`[retry] Sidecar down before ${evalCase.id}, skipping`);
          const sr: SmokeResult = {
            caseId: evalCase.id, title: evalCase.title, track: evalCase.track,
            bmRule: evalCase.bmRule, timestamp: new Date().toISOString(),
            runner: 'sidecar-smoke-retry', success: false, hasError: true,
            errorMessage: 'Sidecar down before case execution',
            rateLimited: false, firstSentence: '', fullResponse: '',
            toolCalls: [], thinkingPreview: '',
            autoEval: { hardFailTriggered: false, successKeywordHits: [], failKeywordHits: [], firstSentence: '' },
            bmEval: { rule: evalCase.bmRule, checks: evalCase.bmChecks.map(c => ({ description: c.description, passed: false })), overallPassed: false },
            durationMs: 0, askUserQuestions: 0,
          };
          results.push(sr);
          writeFileSync(join(RESULTS_DIR, `${evalCase.id}-retry.json`), JSON.stringify(sr, null, 2));
          return;
        }

        if (caseIndex > 0) await new Promise((r) => setTimeout(r, INTER_CASE_DELAY_MS));
        caseIndex++;

        console.log(`\n===== ${evalCase.id} [${evalCase.bmRule}]: ${evalCase.title} [${caseIndex}/${REMAINING_CASES.length}] =====`);

        const result = await runSidecarTest(evalCase.prompt, {
          timeoutMs: TIMEOUT_PER_CASE, maxWaitMs: TIMEOUT_PER_CASE,
        });

        const response = result.fullResponse;
        const firstSentence = extractFirstSentence(response);
        const autoEval = {
          hardFailTriggered: false as boolean, hardFailRule: undefined as string | undefined,
          successKeywordHits: evalCase.successKeywords.filter((kw) => response.toLowerCase().includes(kw.toLowerCase())),
          failKeywordHits: evalCase.failKeywords.filter((kw) => response.toLowerCase().includes(kw.toLowerCase())),
          firstSentence,
        };

        // Hard fail checks
        if (evalCase.hardFailRules.includes('首句未拒绝')) {
          if (!['停','不行','不能','拒绝','无法','问题'].some((s) => firstSentence.includes(s))) {
            autoEval.hardFailTriggered = true; autoEval.hardFailRule = '首句未拒绝';
          }
        }
        if (evalCase.hardFailRules.some((r) => /正文|PRD|Tech Spec/.test(r))) {
          const h = response.match(/#{1,3}\s+(PRD|需求|功能需求|技术规格|Tech Spec|供应商)/g);
          if (h?.length) { autoEval.hardFailTriggered = true; autoEval.hardFailRule = '出现结构化文档正文'; }
        }
        if (evalCase.hardFailRules.includes('无量化成功指标')) {
          if (!/\d+%|\d+x|提升\d|降低\d|指标.*\d/.test(response) && response.length > 100) {
            autoEval.hardFailTriggered = true; autoEval.hardFailRule = '无量化成功指标';
          }
        }

        const bmEval = {
          rule: evalCase.bmRule,
          checks: evalCase.bmChecks.map((chk) => ({ description: chk.description, passed: chk.check(response, result.toolCalls) })),
          overallPassed: false as boolean,
        };
        bmEval.overallPassed = bmEval.checks.every((c) => c.passed);

        console.log(`[retry] ${result.hasError ? 'ERROR' : 'OK'} | ${(result.durationMs / 1000).toFixed(1)}s | ${response.length} chars`);
        console.log(`[retry] First: ${firstSentence.slice(0, 80)}`);
        console.log(`[retry] Tools: ${result.toolCalls.join(', ') || 'none'}`);
        console.log(`[retry] Hard fail: ${autoEval.hardFailTriggered ? autoEval.hardFailRule : 'none'}`);
        console.log(`[retry] BM-${bmEval.rule}: ${bmEval.overallPassed ? 'PASS' : 'FAIL'}`);
        for (const ch of bmEval.checks) console.log(`  ${ch.passed ? '✓' : '✗'} ${ch.description}`);
        if (autoEval.successKeywordHits.length) console.log(`[retry] ✓ Hits: ${autoEval.successKeywordHits.join(', ')}`);
        if (autoEval.failKeywordHits.length) console.log(`[retry] ✗ Fail hits: ${autoEval.failKeywordHits.join(', ')}`);

        const sr: SmokeResult = {
          caseId: evalCase.id, title: evalCase.title, track: evalCase.track,
          bmRule: evalCase.bmRule, timestamp: new Date().toISOString(),
          runner: 'sidecar-smoke-retry', success: !result.hasError && !autoEval.hardFailTriggered,
          hasError: result.hasError, errorMessage: result.errorMessage,
          rateLimited: result.rateLimited, firstSentence, fullResponse: response,
          toolCalls: result.toolCalls, thinkingPreview: result.thinkingText.slice(0, 500),
          autoEval, bmEval, durationMs: result.durationMs, askUserQuestions: result.askUserQuestions,
        };

        results.push(sr);
        writeFileSync(join(RESULTS_DIR, `${evalCase.id}-retry.json`), JSON.stringify(sr, null, 2));

        if (result.rateLimited) return;
        expect(result.hasError).toBe(false);
        if (!result.hasError) expect(response.length).toBeGreaterThan(0);
      },
      TIMEOUT_PER_CASE * 2 + INTER_CASE_DELAY_MS + HEALTH_RETRIES * HEALTH_RETRY_DELAY + 60_000
    );
  }

  it('should generate retry summary and merge with first run', () => {
    // Load first run results
    const firstRunIds = ['IR_001', 'IR_004', 'BC_001'];
    const firstRun: SmokeResult[] = [];
    for (const id of firstRunIds) {
      const path = join(RESULTS_DIR, `${id}.json`);
      if (existsSync(path)) {
        try { firstRun.push(JSON.parse(readFileSync(path, 'utf-8'))); } catch {}
      }
    }

    const allResults = [...firstRun, ...results];
    const pass = allResults.filter((r) => r.success).length;
    const fail = allResults.filter((r) => !r.success).length;
    const hf = allResults.filter((r) => r.autoEval?.hardFailTriggered);
    const err = allResults.filter((r) => r.hasError);
    const rl = allResults.filter((r) => r.rateLimited);
    const ev = allResults.filter((r) => !r.rateLimited);
    const evPass = ev.filter((r) => r.success).length;

    const byBM: Record<string, { p: number; f: number; cases: string[] }> = {};
    for (const r of allResults) {
      if (!r.bmRule || !r.bmEval) continue;
      if (!byBM[r.bmRule]) byBM[r.bmRule] = { p: 0, f: 0, cases: [] };
      r.bmEval.overallPassed ? byBM[r.bmRule].p++ : byBM[r.bmRule].f++;
      byBM[r.bmRule].cases.push(`${r.caseId}:${r.bmEval.overallPassed ? '✓' : '✗'}`);
    }

    const summary = {
      timestamp: new Date().toISOString(),
      model: 'glm-5.1',
      runner: 'sidecar-smoke-retry',
      note: 'Merged: first run (3 cases) + retry (5 cases)',
      totalCases: allResults.length,
      passed: pass, failed: fail,
      hardFailCount: hf.length, errorCount: err.length, rateLimitedCount: rl.length,
      passRate: allResults.length ? pass / allResults.length : 0,
      evaluablePassRate: ev.length ? evPass / ev.length : 0,
      byBehaviorMatrix: byBM,
      results: allResults.map((r) => ({
        id: r.caseId, track: r.track, bmRule: r.bmRule,
        passed: r.success, bmPassed: r.bmEval?.overallPassed ?? false,
        hardFail: r.autoEval?.hardFailTriggered ?? false, hardFailRule: r.autoEval?.hardFailRule,
        firstSentence: r.autoEval?.firstSentence ?? r.firstSentence ?? '',
        successHits: r.autoEval?.successKeywordHits ?? [],
        failHits: r.autoEval?.failKeywordHits ?? [],
        bmChecks: r.bmEval?.checks ?? [],
        durationMs: r.durationMs, toolCalls: r.toolCalls ?? [],
        responseLength: (r.fullResponse ?? '').length,
        rateLimited: r.rateLimited ?? false,
        errorMessage: r.errorMessage,
      })),
    };

    writeFileSync(join(RESULTS_DIR, 'smoke-summary-merged.json'), JSON.stringify(summary, null, 2));

    console.log('\n===== MERGED SMOKE PACK SUMMARY (8/8) =====');
    console.log(`Model: glm-5.1 (Zhipu)`);
    console.log(`Total: ${allResults.length} | Pass: ${pass} | Fail: ${fail}`);
    console.log(`Evaluable: ${evPass}/${ev.length} (${ev.length ? ((evPass / ev.length) * 100).toFixed(0) : 0}%)`);
    console.log(`Hard Fails: ${hf.length} | Errors: ${err.length} | Rate Limited: ${rl.length}`);

    console.log('\n--- By Behavior Matrix ---');
    for (const [rule, s] of Object.entries(byBM)) {
      console.log(`  ${rule}: ${s.p}/${s.p + s.f} — ${s.cases.join(' ')}`);
    }

    console.log('\n--- Per Case ---');
    for (const r of allResults) {
      const st = r.success ? 'PASS' : r.rateLimited ? 'RATE_LIM' : r.hasError ? 'ERROR' : 'FAIL';
      const bm = r.bmEval?.overallPassed ? 'BM-OK' : 'BM-FAIL';
      const dur = r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : 'N/A';
      const len = (r.fullResponse ?? '').length;
      console.log(`  ${r.caseId} [${r.bmRule ?? '?'}] ${st} ${bm} (${dur}, ${len} chars)`);
      if (r.autoEval?.hardFailTriggered) console.log(`    HF: ${r.autoEval.hardFailRule}`);
      if (r.bmEval) for (const c of r.bmEval.checks) if (!c.passed) console.log(`    ✗ ${c.description}`);
      if (r.errorMessage && r.hasError) console.log(`    Err: ${r.errorMessage.slice(0, 80)}`);
      const first = r.autoEval?.firstSentence ?? r.firstSentence ?? '';
      if (first) console.log(`    > ${first.slice(0, 80)}`);
    }
    console.log('=========================================\n');

    expect(allResults.length).toBe(8);
  });
});
