import type { ChatTool, Speko } from '@spekoai/sdk';

export interface RegisteredToolsLoaderOptions {
  /**
   * Initialised Speko client. The loader reads tools via
   * `speko.agents.tools.listChatTools(agentId)`, so auth and base URL come
   * straight from the client — no separate `apiKey`/`baseUrl` needed.
   */
  readonly speko: Speko;
  /** Agent identifier the worker is serving — must be a real agent id. */
  readonly agentId: string;
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
 * outcome than a brief loss of registered tools.
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
    this.#pending = this.#fetch();
    return this.#pending;
  }

  async #fetch(): Promise<ChatTool[] | undefined> {
    const { speko, agentId } = this.#options;

    // Hard timeout — without this, a wedged API or unreachable host
    // blocks the LLM stream's first turn forever, and the symptom is
    // a session that hangs at "Creating speech handle" with no further
    // logs (the loader is awaited inside SpekoLLMStream.run before any
    // SpekoTTS log can fire). The SDK client's own timeout (default 30s)
    // is far too long for a voice turn, so we enforce a tighter one here
    // and forward the signal to listChatTools.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      // `available: true` → the server omits integration tools whose backing
      // installation is disconnected/missing, so the model is never offered a
      // tool that would fail mid-call.
      return await speko.agents.tools.listChatTools(agentId, controller.signal, {
        available: true,
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
  }
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
