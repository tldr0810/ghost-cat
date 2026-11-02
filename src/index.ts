import { consumeA2AStream, replyOrFailure, safeErrorText, validateA2AUrl, A2AError } from './a2a';
import { buildPrompt, parseLines, parseRequest } from './lines';
import type { AgentCredential, Env } from './types';

const TURN_TIMEOUT_MS = 25_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

function credential(env: Env): AgentCredential | null {
  if (!env.MANYFOLD_AGENT_RPC_URL || !env.MANYFOLD_AGENT_TOKEN) return null;
  const production = (env.ENVIRONMENT ?? 'production') === 'production';
  const label = env.MANYFOLD_AGENT_LABEL || 'Manyfold agent';
  return {
    rpcUrl: validateA2AUrl(env.MANYFOLD_AGENT_RPC_URL, production, label),
    token: env.MANYFOLD_AGENT_TOKEN,
    label,
  };
}

async function sha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function handleLines(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: { code: 'bad_request' } }, 400);
  }
  const req = parseRequest(body);
  if (!req) return json({ error: { code: 'bad_request' } }, 400);

  let cred: AgentCredential | null;
  try {
    cred = credential(env);
  } catch (error) {
    return json({ error: { code: 'agent_misconfigured', message: safeErrorText((error as Error).message) } }, 503);
  }
  if (!cred) return json({ error: { code: 'no_agent' } }, 503);

  // One set of lines per ghost, language and time window: reused, so a round rarely bills a turn.
  const ttl = Math.max(0, Number(env.LINES_CACHE_SECONDS ?? 600) || 0);
  const prompt = buildPrompt(req);
  const window = ttl ? Math.floor(Date.now() / 1000 / ttl) : Date.now();
  const key = await sha(`${req.ghostId}|${req.lang}|${prompt}|${window}`);
  const cacheUrl = new URL(`/__lines/${key}`, request.url).toString();
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  if (cache && ttl) {
    const hit = await cache.match(cacheUrl);
    if (hit) return json({ lines: await hit.json(), source: 'cache' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  try {
    const snapshot = await consumeA2AStream({
      cred,
      signal: controller.signal,
      params: {
        message: {
          kind: 'message',
          role: 'user',
          // Same prompt in the same window is the same message, so a double tap cannot bill twice.
          messageId: `ghostcat-${key.slice(0, 32)}`,
          parts: [{ kind: 'text', text: prompt }],
        },
      },
    });
    const reply = replyOrFailure(snapshot, cred.label);
    const lines = parseLines(reply, req.lang);
    if (!lines) return json({ error: { code: 'unparseable' } }, 502);
    if (cache && ttl) {
      ctx.waitUntil(
        cache.put(cacheUrl, new Response(JSON.stringify(lines), { headers: { 'cache-control': `max-age=${ttl}` } })),
      );
    }
    return json({ lines, source: 'agent' });
  } catch (error) {
    const retryable = error instanceof A2AError ? error.retryable : true;
    return json(
      { error: { code: 'agent_failed', retryable, message: safeErrorText((error as Error)?.message ?? error) } },
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      return json({ ok: true, agent: Boolean(env.MANYFOLD_AGENT_RPC_URL && env.MANYFOLD_AGENT_TOKEN) });
    }
    if (url.pathname === '/api/lines') {
      if (request.method !== 'POST') return json({ error: { code: 'method_not_allowed' } }, 405);
      return handleLines(request, env, ctx);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: { code: 'not_found' } }, 404);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
