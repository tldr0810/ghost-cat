/**
 * A2A client, copied from manyfold-open/manyfold-fortune-stick (MIT License, Copyright (c) 2026 Manyfold).
 */
import type { AgentCredential } from './types';

const PROBE_TIMEOUT_MS = 20_000;
const CARD_TIMEOUT_MS = 10_000;
const ERROR_TEXT_LIMIT = 600;

export class A2AError extends Error {
  // Plain fields rather than constructor parameter properties: keeps the class
  // friendly to any TS toolchain that only strips types.
  readonly retryable: boolean;
  readonly refreshCredential: boolean;

  constructor(message: string, retryable: boolean, refreshCredential = false) {
    super(safeErrorText(message));
    this.name = 'A2AError';
    this.retryable = retryable;
    this.refreshCredential = refreshCredential;
  }
}

/** Strips anything token-shaped before an error string can reach a log or the browser. */
export function safeErrorText(value: unknown): string {
  return String(value ?? '')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted-token]')
    .replace(/([?&](?:token|key|secret)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, ERROR_TEXT_LIMIT);
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function looksTransient(message: string): boolean {
  return /\b(timeout|timed out|temporar|unavailable|overload|rate limit|too many|network|fetch failed|connection|socket|internal error|server error|502|503|504)\b/i.test(
    message,
  );
}

export async function fetchTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    const message = safeErrorText(error instanceof Error ? error.message : error);
    const aborted = /abort|timeout/i.test(message) || (error as Error)?.name === 'AbortError';
    throw new A2AError(aborted ? `Request timed out. ${message}` : message, true);
  } finally {
    clearTimeout(timer);
  }
}

/** A URL handed back by Manyfold is still untrusted input; reject anything internal. */
export function validateA2AUrl(raw: string, production: boolean, label: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new A2AError(`${label} is not a valid URL.`, false);
  }
  if (url.username || url.password) {
    throw new A2AError(`${label} must not carry credentials in the URL.`, false);
  }
  if (url.protocol !== 'https:' && !(!production && url.protocol === 'http:')) {
    throw new A2AError(`${label} must use https.`, false);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const blocked =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1' ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/i.test(host) ||
    /^fe[89ab][0-9a-f]:/i.test(host);
  if (blocked && production) throw new A2AError(`${label} points at a private address.`, false);
  url.hash = '';
  return url.toString();
}

/* ───────── JSON-RPC ───────── */

function rpcBody(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', method, id: crypto.randomUUID(), params });
}

function jsonRpcError(value: unknown, label: string): A2AError {
  const error = (value ?? {}) as Record<string, unknown>;
  const code = typeof error.code === 'number' ? error.code : undefined;
  const message = safeErrorText(error.message ?? error.data ?? JSON.stringify(error));
  // -32700/-32600/-32601/-32602 mean we sent something wrong; retrying sends it again.
  const permanent = code === -32700 || code === -32600 || code === -32601 || code === -32602;
  return new A2AError(
    `${label} RPC error${code === undefined ? '' : ` ${code}`}: ${message}`,
    !permanent && looksTransient(message),
  );
}

async function httpFailure(response: Response, label: string): Promise<A2AError> {
  const detail = safeErrorText(await response.text());
  return new A2AError(
    `${label} failed: HTTP ${response.status}${detail ? ` · ${detail}` : ''}`,
    retryableStatus(response.status) || response.status === 401,
    response.status === 401,
  );
}

/**
 * Connectivity probe: ask for a task id that cannot exist.
 *
 * Deliberately not `message/send` — that would run a real turn, so connecting N agents
 * would bill N turns. Only the auth answer matters: 401/403 means the token is rejected;
 * anything else (including a JSON-RPC "no such task" error) means token and endpoint work.
 */
export async function probeAgentAuth(cred: AgentCredential): Promise<void> {
  const response = await fetchTimeout(
    cred.rpcUrl,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cred.token}` },
      body: rpcBody('tasks/get', { id: `probe-${crypto.randomUUID()}` }),
      redirect: 'manual',
    },
    PROBE_TIMEOUT_MS,
  );
  if (response.status === 401 || response.status === 403) {
    throw new A2AError(`${cred.label} rejected this token (HTTP ${response.status}).`, false, true);
  }
  if (!response.ok && response.status >= 500) {
    throw new A2AError(`${cred.label} is temporarily unavailable (HTTP ${response.status}).`, true);
  }
}

/** Best-effort agent-card read for a description; cards are public, so no bearer is sent. */
export async function describeFromCard(cardUrl: string): Promise<string> {
  try {
    const response = await fetchTimeout(
      cardUrl,
      { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual' },
      CARD_TIMEOUT_MS,
    );
    if (!response.ok) return '';
    const card = (await response.json()) as Record<string, unknown>;
    return typeof card.description === 'string' ? card.description.slice(0, 240) : '';
  } catch {
    return '';
  }
}

/* ───────── streaming ───────── */

/** 终态里代表「这一轮没成」的那些。失败时才值得多等一帧错误说明。 */
export const FAILURE_STATES = new Set(['failed', 'canceled', 'rejected', 'auth-required']);

/** 失败终态之后，最多再等多久去接那一帧说明原因的 JSON-RPC error。 */
const ERROR_FRAME_GRACE_MS = 1_500;

export const TERMINAL_STATES = new Set([
  'completed',
  'failed',
  'canceled',
  'rejected',
  'input-required',
  'auth-required',
]);

/**
 * The reply text of a finished turn, or the reason it did not finish.
 *
 * A turn that ended in a failure state is a failure even when it carries text: an
 * agent reports why it failed (「The agent's computer is unavailable」) in the status
 * message, and the accumulator uses that as the reply when nothing else was said.
 * Without this check the sentence is handed to the interpretation parser and, having
 * no braces, is printed on the slip as if it were the reading.
 */
export function replyOrFailure(snapshot: StreamSnapshot, label: string): string {
  const reply = snapshot.text.trim();
  if (FAILURE_STATES.has(snapshot.state)) {
    // 说得出原因就带上原因，排查的人要看的就是这一句。
    throw new A2AError(
      reply
        ? `${label} 在 ${snapshot.state} 状态下结束：${reply}`
        : `${label} 在 ${snapshot.state} 状态下结束，没有返回任何内容。`,
      snapshot.state === 'failed' || snapshot.state === 'canceled',
      snapshot.state === 'auth-required',
    );
  }
  // agent 自己失败了（没配模型、额度用完、内部报错）和「回了内容但格式不对」是两回事：
  // 不在这里分开，两种情况都会落到「解签内容没有按预期返回」，排查的人会被带去改提示词，
  // 而真正的原因在 agent 那一侧。
  if (!reply) {
    throw new A2AError(
      snapshot.state && snapshot.state !== 'completed'
        ? `${label} 在 ${snapshot.state} 状态下结束，没有返回任何内容。`
        : `${label} 没有返回任何内容。`,
      true,
    );
  }
  return reply;
}

export interface StreamSnapshot {
  taskId: string | null;
  contextId: string | null;
  state: string;
  /** Full reply text accumulated so far. */
  text: string;
  /** Progress text from status.message, when it differs from the reply itself. */
  progressText: string;
  terminal: boolean;
}

interface StreamAccumulator {
  taskId: string | null;
  contextId: string | null;
  state: string;
  artifacts: Map<string, string>;
  order: string[];
  directText: string;
  statusText: string;
}

export function createAccumulator(): StreamAccumulator {
  return {
    taskId: null,
    contextId: null,
    state: '',
    artifacts: new Map(),
    order: [],
    directText: '',
    statusText: '',
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function partsText(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  return raw
    .map((part) =>
      part && typeof part === 'object' && typeof (part as any).text === 'string'
        ? ((part as any).text as string)
        : '',
    )
    .filter(Boolean)
    .join('\n');
}

export function normalizeState(value: unknown): string {
  const raw = String(value ?? '')
    .toLowerCase()
    .replace(/^task_state_/, '')
    .replace(/_/g, '-');
  return [
    'submitted',
    'working',
    'completed',
    'failed',
    'canceled',
    'rejected',
    'input-required',
    'auth-required',
  ].includes(raw)
    ? raw
    : '';
}

/** Folds one JSON-RPC `result` (task, message, status-update or artifact-update) in. */
export function applyA2AResult(accumulator: StreamAccumulator, raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const value = raw as Record<string, unknown>;
  const kind = String(value.kind ?? '').toLowerCase();
  const taskId = stringValue(value.taskId) ?? stringValue(value.id);
  const contextId = stringValue(value.contextId);
  if (taskId) accumulator.taskId = taskId;
  if (contextId) accumulator.contextId = contextId;

  if (kind === 'artifact-update' || value.artifact) {
    const artifact = (value.artifact ?? {}) as Record<string, unknown>;
    const id = stringValue(artifact.artifactId) ?? stringValue(artifact.id) ?? 'artifact';
    const text = partsText(artifact.parts);
    if (!accumulator.order.includes(id)) accumulator.order.push(id);
    // A2A 0.3 puts append on the event; a few compatible servers put it on the
    // artifact object. Accept both forms so streamed text is not reduced to the
    // last chunk before the interpretation parser sees it.
    const append = value.append === true || artifact.append === true;
    accumulator.artifacts.set(
      id,
      append ? `${accumulator.artifacts.get(id) ?? ''}${text}` : text,
    );
  }

  if (kind === 'message' || (value.role && value.parts)) {
    accumulator.directText = partsText(value.parts) || accumulator.directText;
  }

  const status = (value.status ?? {}) as Record<string, unknown>;
  const state = normalizeState(status.state ?? value.state);
  if (state) accumulator.state = state;
  const statusMessage = status.message as Record<string, unknown> | undefined;
  if (statusMessage) {
    accumulator.statusText = partsText(statusMessage.parts) || accumulator.statusText;
  }

  // A full task object may carry finished artifacts inline.
  const artifacts = value.artifacts as Array<Record<string, unknown>> | undefined;
  for (const artifact of artifacts ?? []) {
    const id = stringValue(artifact.artifactId) ?? stringValue(artifact.id) ?? crypto.randomUUID();
    if (!accumulator.order.includes(id)) accumulator.order.push(id);
    accumulator.artifacts.set(id, partsText(artifact.parts));
  }
}

export function snapshotFrom(accumulator: StreamAccumulator): StreamSnapshot {
  const artifactText = accumulator.order
    .map((id) => accumulator.artifacts.get(id) ?? '')
    .filter(Boolean)
    .join('\n\n');
  const text = artifactText || accumulator.directText || accumulator.statusText;
  return {
    taskId: accumulator.taskId,
    contextId: accumulator.contextId,
    state: accumulator.state,
    text,
    // Suppressed when it is itself the answer, so the UI never shows the same
    // sentence twice — once as progress and once as the reply.
    progressText: text === accumulator.statusText ? '' : accumulator.statusText,
    terminal: TERMINAL_STATES.has(accumulator.state),
  };
}

/** Test/dev helper: fold a sequence of JSON-RPC results into one snapshot. */
export function foldA2AResults(results: unknown[]): StreamSnapshot {
  const accumulator = createAccumulator();
  for (const result of results) applyA2AResult(accumulator, result);
  return snapshotFrom(accumulator);
}

/**
 * One `message/stream` turn. Emits a snapshot after every SSE event and resolves with
 * the final one. Requires the endpoint to answer with text/event-stream — there is no
 * `message/send` fallback, by design: Manyfold agents stream, and one protocol path
 * keeps this template small.
 */
export async function consumeA2AStream(options: {
  cred: AgentCredential;
  params: Record<string, unknown>;
  signal: AbortSignal;
  onSnapshot?: (snapshot: StreamSnapshot) => Promise<void> | void;
}): Promise<StreamSnapshot> {
  const { cred } = options;
  let response: Response;
  try {
    response = await fetch(cred.rpcUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${cred.token}`,
      },
      redirect: 'manual',
      signal: options.signal,
      body: rpcBody('message/stream', options.params),
    });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw new A2AError(`${cred.label} stream timed out.`, true);
    }
    throw new A2AError(safeErrorText(error instanceof Error ? error.message : error), true);
  }
  if (!response.ok) throw await httpFailure(response, cred.label);
  if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
    throw new A2AError(`${cred.label} does not support A2A streaming (message/stream).`, false);
  }
  if (!response.body) throw new A2AError(`${cred.label} streaming response had no body.`, true);

  const accumulator = createAccumulator();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  let received = false;
  let terminal: StreamSnapshot | null = null;
  let graceDeadline: number | null = null;

  /**
   * 把 buffer 里已经完整的事件块都消化掉。
   *
   * `flush` 是流关掉之后补的那一次：SSE 的最后一个事件允许不带收尾空行，对方写完
   * 最后一行就关连接。不补这一手，那一块（往往就是整段解签）会一直留在 buffer 里
   * 被丢掉，上游只看到「一个事件都没有」，agent 明明回了。
   */
  const drain = async (flush: boolean): Promise<StreamSnapshot | null> => {
    let reached: StreamSnapshot | null = null;
    if (flush && buffer.trim()) buffer += '\n\n';
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data && data !== '[DONE]') {
        let envelope: Record<string, unknown>;
        try {
          envelope = JSON.parse(data) as Record<string, unknown>;
        } catch {
          throw new A2AError(`${cred.label} stream emitted invalid JSON.`, true);
        }
        if (envelope.error) throw jsonRpcError(envelope.error, cred.label);
        applyA2AResult(accumulator, envelope.result);
        received = true;
        const snapshot = snapshotFrom(accumulator);
        await options.onSnapshot?.(snapshot);
        // 记下来但不一定马上返回：有的 agent（Manyfold 就是）把带原因的 JSON-RPC error
        // 帧放在 final:true 之后。立刻 return 会把唯一一句说明失败原因的话丢掉
        // （比如 "Codex model is required"），上游只能看到「没有文本」。
        if (snapshot.terminal) reached = snapshot;
      }
      boundary = buffer.indexOf('\n\n');
    }
    return reached;
  };

  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        // 已经拿到失败终态、正在等原因时，读取本身也要有上限，否则一个不关闭的流
        // 会把这次等待拖到整轮超时。
        if (graceDeadline === null) {
          chunk = await reader.read();
        } else {
          let graceTimer: ReturnType<typeof setTimeout> | null = null;
          try {
            chunk = await Promise.race([
              reader.read(),
              new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
                graceTimer = setTimeout(
                  () => resolve({ done: true, value: undefined }),
                  ERROR_FRAME_GRACE_MS,
                );
              }),
            ]);
          } finally {
            if (graceTimer !== null) clearTimeout(graceTimer);
          }
        }
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') {
          throw new A2AError(`${cred.label} stream timed out.`, true);
        }
        throw error;
      }
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
      terminal = (await drain(false)) ?? terminal;
      if (terminal) {
        // 正常收场（有内容，或者是 completed / input-required 这类状态）就直接返回，
        // 一秒都不多等。只有「失败且什么都没说」才值得再听一下原因，并且用 deadline
        // 兜住：对方把流挂住不关，这里也只多花 ERROR_FRAME_GRACE_MS。
        if (!FAILURE_STATES.has(terminal.state) || terminal.text) return terminal;
        if (graceDeadline === null) graceDeadline = Date.now() + ERROR_FRAME_GRACE_MS;
        else if (Date.now() >= graceDeadline) return terminal;
      }
    }
  } finally {
    reader.releaseLock();
  }
  // 流关了，再把没有空行收尾的最后一块读出来。
  await drain(true);
  // 字节数是这里唯一能分开「agent 真的什么都没说」和「说了但我们没认出来」的线索，
  // 它会跟着错误一路存进 readings.error，所以写进这句话里。
  if (!received) {
    throw new A2AError(`${cred.label} stream ended without events (${bytes} bytes).`, true);
  }
  return snapshotFrom(accumulator);
}
