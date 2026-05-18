import type { ChatTool, ChatToolSource } from '@spekoai/sdk';

/**
 * Wire shape returned by the server's `GET /v1/agents/:agentId/tools`
 * endpoint. Mirrors `SerializedTool` in `apps/server/src/routes/agent-tools.ts`
 * — kept as a local copy to avoid a runtime import on `@spekoai/server`
 * from the published adapter. If the server contract drifts, the unit
 * test for `serializedToolToChatTool` is the canary.
 */
export interface SerializedAgentTool {
  readonly id: string;
  readonly agentId: string;
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly source: SerializedAgentToolSource;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type SerializedAgentToolSource =
  | { kind: 'inline' }
  | {
      kind: 'webhook';
      url: string;
      secretRef: string;
      headers?: Record<string, string>;
      timeoutMs?: number;
    }
  | { kind: 'builtin'; name: string; config?: unknown };

export interface RegisteredToolsLoaderOptions {
  /** Speko API base URL (e.g. `https://api.speko.dev`). */
  readonly baseUrl: string;
  /** API key — same one configured on the `Speko` client. */
  readonly apiKey: string;
  /** Agent identifier the worker is serving — must be a real agent id. */
  readonly agentId: string;
  /**
   * Override the global `fetch` — used by tests to inject a fake. Defaults
   * to `globalThis.fetch`.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Called once when the load fails (network error or non-2xx). The voice
   * call still proceeds with whatever runtime tools LiveKit provided —
   * the registered-tools failure is a non-fatal soft degradation, not a
   * crash. Hosts wire this to their structured logger.
   */
  readonly onError?: (err: Error) => void;
}

const FETCH_TIMEOUT_MS = 5_000;

/**
 * One-shot, lazy loader for an agent's registered tools.
 *
 * Voice sessions live for seconds-to-minutes and call `chat()` many
 * times; we MUST NOT re-fetch the registered tools list on every turn.
 * The loader memoizes the first `load()` call (success or failure) for
 * the lifetime of the SpekoLLM instance, which the LiveKit framework
 * scopes to one session.
 *
 * Failure handling is intentionally permissive: returning `undefined`
 * lets the caller fall back to runtime-only tools. Crashing the call
 * because the tools API was momentarily unavailable would be a worse
 * outcome than a brief loss of webhook tools.
 */
export class RegisteredToolsLoader {
  readonly #options: RegisteredToolsLoaderOptions;
  #pending: Promise<ChatTool[] | undefined> | undefined;

  constructor(options: RegisteredToolsLoaderOptions) {
    this.#options = options;
  }

  /**
   * Fetch (once) and return the agent's registered tools as `ChatTool[]`.
   * Subsequent calls return the cached result, including when the first
   * call failed.
   */
  load(): Promise<ChatTool[] | undefined> {
    if (this.#pending) return this.#pending;
    this.#pending = this.#fetchAndTransform();
    return this.#pending;
  }

  async #fetchAndTransform(): Promise<ChatTool[] | undefined> {
    const { baseUrl, apiKey, agentId } = this.#options;
    const fetchImpl = this.#options.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
      this.#options.onError?.(new Error('SpekoAdapter: no global fetch available'));
      return undefined;
    }
    const trimmed = baseUrl.replace(/\/+$/, '');
    const url = `${trimmed}/v1/agents/${encodeURIComponent(agentId)}/tools`;

    // Hard timeout — without this, a wedged API or unreachable host
    // blocks the LLM stream's first turn forever, and the symptom is
    // a session that hangs at "Creating speech handle" with no further
    // logs (the loader is awaited inside SpekoLLMStream.run before any
    // SpekoTTS log can fire).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } catch (err) {
      this.#options.onError?.(
        err instanceof Error
          ? new Error(`SpekoAdapter: failed to fetch agent tools: ${err.message}`)
          : new Error('SpekoAdapter: failed to fetch agent tools'),
      );
      return undefined;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let body = '';
      try {
        body = await response.text();
      } catch {
        // ignore — message below is informative enough
      }
      this.#options.onError?.(
        new Error(
          `SpekoAdapter: agent tools fetch returned HTTP ${response.status}${
            body ? ` — ${body}` : ''
          }`,
        ),
      );
      return undefined;
    }

    let rows: unknown;
    try {
      rows = await response.json();
    } catch (err) {
      this.#options.onError?.(
        new Error(
          `SpekoAdapter: agent tools response was not valid JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
      return undefined;
    }
    if (!Array.isArray(rows)) {
      this.#options.onError?.(new Error('SpekoAdapter: agent tools response was not an array'));
      return undefined;
    }

    const tools: ChatTool[] = [];
    for (const raw of rows) {
      const tool = raw as SerializedAgentTool;
      if (!tool || typeof tool.name !== 'string') continue;
      tools.push(serializedToolToChatTool(tool));
    }
    return tools;
  }
}

/**
 * Convert a server-side `SerializedAgentTool` into the SDK's `ChatTool`
 * shape that `/v1/complete` consumes. Sets `executionMode` based on the
 * `source.kind`:
 *
 *   - `webhook` → `executionMode: 'webhook'` + full webhook source
 *     (including `secretRef` so the proxy can resolve the signing
 *     secret server-side).
 *   - `builtin` → `executionMode: 'builtin'` + the `{ name, config? }`
 *     source.
 *   - `inline`  → `executionMode: 'inline'` and NO `source` field
 *     (matches the v0.3 contract: callers describe an inline tool
 *     with just `name/description/parameters`).
 */
export function serializedToolToChatTool(tool: SerializedAgentTool): ChatTool {
  const base = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };

  if (tool.source.kind === 'webhook') {
    const source: ChatToolSource = {
      kind: 'webhook',
      url: tool.source.url,
      secretRef: tool.source.secretRef,
      ...(tool.source.headers !== undefined && { headers: tool.source.headers }),
      ...(tool.source.timeoutMs !== undefined && { timeoutMs: tool.source.timeoutMs }),
    };
    return { ...base, executionMode: 'webhook', source };
  }

  if (tool.source.kind === 'builtin') {
    const source: ChatToolSource = {
      kind: 'builtin',
      name: tool.source.name,
      ...(tool.source.config !== undefined && { config: tool.source.config }),
    };
    return { ...base, executionMode: 'builtin', source };
  }

  // Inline — emit no `source` so the proxy treats it as the v0.3 default.
  return { ...base, executionMode: 'inline' };
}

export interface MergeToolsOptions {
  /**
   * Called once per name where a runtime tool was overridden by a
   * registered tool. Useful for debug logging when the customer
   * unintentionally collides names.
   */
  readonly onOverride?: (name: string) => void;
}

/**
 * Merge registered tools with LiveKit-runtime tools.
 *
 * Conflict policy: a tool registered in `agent_tool` is the customer's
 * authoritative declaration — they typed it into the dashboard and
 * expect it to be the one the model sees. So registered wins on name
 * collision, and we (optionally) emit one debug call for visibility.
 *
 * Returns `undefined` when the merged result is empty so callers can
 * forward `undefined` to the proxy (skipping the `tools` field
 * entirely, matching the no-tools wire shape).
 */
export function mergeTools(
  registered: readonly ChatTool[] | undefined,
  runtime: readonly ChatTool[] | undefined,
  opts: MergeToolsOptions = {},
): ChatTool[] | undefined {
  const reg = registered ?? [];
  const run = runtime ?? [];
  if (reg.length === 0 && run.length === 0) return undefined;

  const byName = new Map<string, ChatTool>();
  // Runtime first so registered wins on collision (Map.set replaces).
  for (const t of run) byName.set(t.name, t);
  for (const t of reg) {
    if (byName.has(t.name)) opts.onOverride?.(t.name);
    byName.set(t.name, t);
  }
  return [...byName.values()];
}
