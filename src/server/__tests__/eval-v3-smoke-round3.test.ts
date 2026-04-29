/**
 * Eval-v3 Smoke Pack Round 3 — Remaining 3 Cases
 * WF_003, AQ_001, ST_004 on kimi-k2.5 @ port 31418
 *
 * Uses correct Sidecar SSE protocol:
 *   - Send: { text, permissionMode }
 *   - Events: chat:message-chunk, chat:status, chat:tool-use-start, etc.
 *   - Completion: chat:status sessionState=idle after activity
 *   - AskUserQuestion: /api/ask-user-question/respond
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const SIDECAR_BASE = 'http://127.0.0.1:31418';
const RESULTS_DIR = join(import.meta.dir, '../../../validation/eval-v3/results-smoke');

const CASES = [
  {
    id: 'WF_003', title: 'Writer-pipeline 阶段质量门', track: 'workflow-orchestration', bmRule: 'BM-3',
    prompt: `我已经有一份 AI 审单功能的 PRD 草稿，路径是 ai-approval-prd-draft.md。
请帮我用 pm-writer-pipeline 从这份 PRD 草稿开始，产出完整的技术规格和发布计划。`,
    timeout: 300_000,
    successKeywords: ['质量门', '阶段', '门控', 'Phase', 'gate', '一致性', '检查'],
    failKeywords: [],
    hardFailRules: [] as string[],
    bmChecks: [
      { desc: '提及质量门/门控检查', test: (r: string) => /质量[门控]|门控|Phase\s*\d|gate|阶段.*检查/i.test(r) },
      { desc: '阶段间有承接（引用前序产出）', test: (r: string) => /PRD.*草稿|已有.*PRD|基于.*PRD|前序/i.test(r) },
    ],
  },
  {
    id: 'AQ_001', title: 'Release 级 PRD 保真度', track: 'artifact-quality', bmRule: 'BM-2',
    prompt: `这是我们 AI 审单功能的 PROJECT_BRIEF.md 和 DECISION_LOG.md。
请基于这些文件，用 pm-prd Skill 写一份 Release 级别的 PRD（交付开发用）。
保真度设为 Release。`,
    timeout: 300_000,
    successKeywords: ['Release', '量化', '指标', 'guardrail', '护栏', '验收标准', 'KPI'],
    failKeywords: [],
    hardFailRules: [] as string[],
    bmChecks: [
      { desc: '包含量化指标/KPI', test: (r: string) => /\d+%|\d+x|KPI|指标.*\d|量化|guardrail|护栏/i.test(r) },
      { desc: '包含验收标准', test: (r: string) => /验收标准|acceptance|AC[:：]/i.test(r) },
    ],
  },
  {
    id: 'ST_004', title: '历史冲突 soft-refuse', track: 'stateful-behavior', bmRule: 'BM-2',
    prompt: `我们之前已经决定用 Monorepo 架构了（见 DECISION_LOG.md）。
但我最近看了很多 Microservices 的文章，觉得 Monorepo 可能不够灵活。
帮我写一份从 Monorepo 迁移到 Microservices 的 PRD。`,
    timeout: 120_000,
    successKeywords: ['决策', '冲突', '已有', 'DECISION_LOG', 'soft-refuse', '不建议'],
    failKeywords: [],
    hardFailRules: ['直接输出完整 PRD 正文'],
    bmChecks: [
      { desc: '识别已有决策冲突', test: (r: string) => /决策.*日志|DECISION_LOG|已有.*决策|Monorepo.*已|之前.*决定/i.test(r) },
      { desc: '不直接产出迁移 PRD', test: (r: string) => !/Microservices.*迁移|迁移.*Microservices.*PRD|PRD.*迁移/i.test(r) },
    ],
  },
];

interface SSEEvent { event: string; data: string; }

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

async function runTest(prompt: string, timeoutMs: number) {
  const startTime = Date.now();
  const result = {
    fullResponse: '', toolCalls: [] as string[], thinkingText: '',
    durationMs: 0, rateLimited: false, askUserQuestions: 0,
    hasError: false, errorMessage: '',
  };

  // Reset
  try {
    await fetch(`${SIDECAR_BASE}/chat/reset`, { method: 'POST', signal: AbortSignal.timeout(10_000) });
  } catch {}
  await new Promise(r => setTimeout(r, 3000));

  // SSE connect
  const sseController = new AbortController();
  const sseRes = await fetch(`${SIDECAR_BASE}/chat/stream`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!sseRes.ok || !sseRes.body) throw new Error(`SSE connect failed: ${sseRes.status}`);

  // Read SSE in background
  let sseDone = false;
  let hasReceivedActivity = false;
  const sseReader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const ssePromise = (async () => {
    while (!sseDone) {
      const { done, value } = await sseReader.read();
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
                console.log(`[r3] Auto-answering ${p.questions.length} questions`);
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
                sseDone = true;
                sseController.abort();
                return;
              }
            } catch {}
          } else if (evt.event === 'chat:message-error' || evt.event === 'chat:agent-error') {
            if (/rate.limit|429/i.test(evt.data)) {
              console.log(`[r3] Rate limit (SDK will retry)`);
              result.rateLimited = true;
            } else {
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

  await new Promise(r => setTimeout(r, 500));

  // Send prompt
  const sendRes = await fetch(`${SIDECAR_BASE}/chat/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: prompt, permissionMode: 'fullAgency' }),
  });
  if (!sendRes.ok) {
    const errText = await sendRes.text();
    throw new Error(`Send failed (${sendRes.status}): ${errText}`);
  }

  // Wait for SSE completion or timeout
  await Promise.race([
    ssePromise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), timeoutMs - (Date.now() - startTime))
    ),
  ]).catch(e => {
    if (!sseDone) console.log(`[r3] Timed out after ${(Date.now() - startTime) / 1000}s`);
  });

  result.durationMs = Date.now() - startTime;
  try { sseReader.cancel(); } catch {}
  return result;
}

function autoEval(response: string, keywords: string[], failKeywords: string[], hardFailRules: string[]) {
  let hardFailTriggered = false;
  let hardFailRule = '';
  for (const rule of hardFailRules) {
    if (rule.includes('直接输出完整 PRD') && /#\s+PRD|产品需求文档.*##.*##/s.test(response)) {
      hardFailTriggered = true;
      hardFailRule = rule;
    }
  }
  const hits = keywords.filter(k => response.toLowerCase().includes(k.toLowerCase()));
  const fails = failKeywords.filter(k => response.toLowerCase().includes(k.toLowerCase()));
  return { hardFailTriggered, hardFailRule, successKeywordHits: hits, failKeywordHits: fails };
}

function evalBM(response: string, checks: { desc: string; test: (r: string) => boolean }[]) {
  const results = checks.map(c => ({ description: c.desc, passed: c.test(response) }));
  return { checks: results, overallPassed: results.every(r => r.passed) };
}

describe('eval-v3 smoke round 3 (kimi-k2.5)', () => {
  beforeAll(() => { mkdirSync(RESULTS_DIR, { recursive: true }); });

  for (const tc of CASES) {
    it(`${tc.id} [${tc.bmRule}]: ${tc.title}`, async () => {
      console.log(`\n===== ${tc.id} [${tc.bmRule}]: "${tc.title}" =====`);

      // Health check
      try {
        const hr = await fetch(`${SIDECAR_BASE}/health`, { signal: AbortSignal.timeout(5000) });
        if (!hr.ok) throw new Error('unhealthy');
        console.log(`[r3] Sidecar healthy`);
      } catch {
        console.log(`[r3] SKIP — Sidecar down`);
        saveResult(tc, { fullResponse: '', toolCalls: [], thinkingText: '', durationMs: 0, rateLimited: false, askUserQuestions: 0, hasError: true, errorMessage: 'Sidecar down' }, { hardFailTriggered: false, hardFailRule: '', successKeywordHits: [], failKeywordHits: [] }, { checks: [], overallPassed: false });
        return;
      }

      const result = await runTest(tc.prompt, tc.timeout);
      console.log(`[r3] ${result.fullResponse ? 'OK' : 'EMPTY'} | ${(result.durationMs / 1000).toFixed(1)}s | ${result.fullResponse.length} chars`);
      console.log(`[r3] First: ${result.fullResponse.slice(0, 150)}...`);
      console.log(`[r3] Tools: ${result.toolCalls.join(', ') || 'none'}`);

      const ev = autoEval(result.fullResponse, tc.successKeywords, tc.failKeywords, tc.hardFailRules);
      console.log(`[r3] Hard fail: ${ev.hardFailTriggered ? ev.hardFailRule : 'none'}`);

      const bm = evalBM(result.fullResponse, tc.bmChecks);
      console.log(`[r3] BM-${tc.bmRule}: ${bm.overallPassed ? 'PASS' : 'FAIL'}`);
      for (const c of bm.checks) console.log(`  ${c.passed ? '✓' : '✗'} ${c.description}`);
      if (ev.successKeywordHits.length) console.log(`[r3] ✓ Hits: ${ev.successKeywordHits.join(', ')}`);

      saveResult(tc, result, ev, bm);
      expect(true).toBe(true);
    }, tc.timeout + 60_000);
  }
});

function saveResult(tc: typeof CASES[0], result: ReturnType<typeof runTest> extends Promise<infer T> ? T : never, ev: ReturnType<typeof autoEval>, bm: ReturnType<typeof evalBM>) {
  const record = {
    caseId: tc.id, title: tc.title, track: tc.track, bmRule: tc.bmRule,
    timestamp: new Date().toISOString(), runner: 'sidecar-smoke-round3-kimi', model: 'kimi-k2.5',
    success: !result.hasError, hasError: result.hasError, errorMessage: result.errorMessage || undefined,
    rateLimited: result.rateLimited,
    firstSentence: result.fullResponse.slice(0, 200),
    fullResponse: result.fullResponse,
    toolCalls: result.toolCalls,
    thinkingPreview: result.thinkingText?.slice(0, 500) || '',
    autoEval: ev, bmEval: bm,
    durationMs: result.durationMs, askUserQuestions: result.askUserQuestions,
  };
  writeFileSync(join(RESULTS_DIR, `${tc.id}-round3.json`), JSON.stringify(record, null, 2));
  console.log(`[r3] Saved ${tc.id}-round3.json`);
}
