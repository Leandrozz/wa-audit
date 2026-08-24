/**
 * Pluggable LLM providers over plain fetch — deliberately no SDKs: this
 * project stays dependency-light and provider-neutral, and the analysis
 * contract (analysis/analysis.schema.json) is the real interface. Three
 * providers:
 *
 *   anthropic   POST /v1/messages          env ANTHROPIC_API_KEY
 *   openai      POST /chat/completions     env LLM_API_KEY (any OpenAI-compatible baseUrl)
 *   mock        replays canned JSON responses from a directory — used by the
 *               test suite and by `npm run demo` so the engine's plumbing is
 *               exercised without a key, a network, or a bill
 *
 * complete({system, user, tag}) -> string. `tag` identifies the call site
 * (e.g. "generate-frequent_questions") — the mock provider uses it as the
 * canned-response filename.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const TIMEOUT_MS = 10 * 60 * 1000;

export function createProvider(llmCfg) {
  const { provider } = llmCfg;
  if (provider === 'anthropic') return anthropicProvider(llmCfg);
  if (provider === 'openai') return openaiProvider(llmCfg);
  if (provider === 'mock') return mockProvider(llmCfg);
  throw new Error(`Unknown llm.provider "${provider}" (anthropic | openai | mock)`);
}

function anthropicProvider(cfg) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('llm.provider=anthropic requires ANTHROPIC_API_KEY');
  const model = cfg.model || 'claude-opus-5';
  const baseUrl = (cfg.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  return {
    name: `anthropic:${model}`,
    async complete({ system, user }) {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        // No `thinking` param: current Claude models default to adaptive thinking.
        body: JSON.stringify({
          model,
          max_tokens: cfg.maxTokens ?? 16000,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });
      if (!res.ok) throw new Error(`anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = await res.json();
      if (body.stop_reason === 'refusal') {
        throw new Error(`anthropic refused the request${body.stop_details?.explanation ? `: ${body.stop_details.explanation}` : ''}`);
      }
      const text = (body.content ?? []).find((b) => b.type === 'text')?.text;
      if (!text) throw new Error('anthropic returned no text block');
      return text;
    },
  };
}

function openaiProvider(cfg) {
  const apiKey = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('llm.provider=openai requires LLM_API_KEY (or OPENAI_API_KEY)');
  if (!cfg.model) throw new Error('llm.provider=openai requires llm.model (no default is guessed)');
  const baseUrl = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  return {
    name: `openai:${cfg.model}`,
    async complete({ system, user }) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      if (!res.ok) throw new Error(`openai HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = await res.json();
      const text = body.choices?.[0]?.message?.content;
      if (!text) throw new Error('openai returned no message content');
      return text;
    },
  };
}

function mockProvider(cfg) {
  const dir = cfg.cannedDir || process.env.WA_LLM_CANNED_DIR;
  if (!dir) throw new Error('llm.provider=mock requires WA_LLM_CANNED_DIR (directory with <tag>.json files)');
  return {
    name: 'mock',
    async complete({ tag }) {
      const file = path.join(dir, `${tag}.json`);
      try {
        return readFileSync(file, 'utf8');
      } catch {
        throw new Error(`mock provider: no canned response for "${tag}" (expected ${file})`);
      }
    },
  };
}
