import { llm } from '@livekit/agents';
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

export interface InlineToolContextOptions {
  /**
   * Names already claimed by purpose-built runtime tools (end_call, warm
   * transfer, send_dtmf, …). A registered tool colliding with one of these is
   * skipped — the purpose-built tool carries session behavior the generic
   * capture executor must not shadow.
   */
  readonly reservedNames?: ReadonlySet<string>;
  /**
   * Called after a captured execution, with the tool name and the model's
   * arguments. Hosts wire this to their logger so every recorded call is
   * visible in the worker timeline.
   */
  readonly onExecuted?: (name: string, args: Record<string, unknown>) => void;
}

/**
 * Convert registered INLINE tools into framework function tools with a
 * capture-acknowledge executor, so a voice session can actually complete them.
 *
 * Why this exists (root-caused 2026-07-03 on the reliability loop): a
 * dashboard-registered `inline` tool was definition-only on voice calls. The
 * gateway returns inline tool calls verbatim BY DESIGN (API callers execute
 * their own inline tools client-side), and the LiveKit framework executes only
 * tools present in its ToolContext — which registered tools never entered. So
 * the model would call `place_order`, and nothing anywhere could execute it:
 * the call died silently and the conversation stalled or the model was never
 * offered the tool's result. `webhook` / `builtin` / `integration` tools are
 * deliberately NOT injected here — the gateway executes those server-side and
 * folds the result into the next turn.
 *
 * The executor is capture-acknowledge: it records the call (via `onExecuted`,
 * and the framework persists the FunctionCall/Output into the turn context)
 * and returns `{ status: 'recorded' }` so the model can confirm to the caller
 * and move on. That is the honest v1 semantic for an inline tool with no
 * customer-side runtime attached to the call.
 */
export function inlineToolsToToolContext(
  tools: readonly ChatTool[] | undefined,
  opts: InlineToolContextOptions = {},
): llm.ToolContext {
  const ctx: llm.ToolContext = {};
  for (const t of tools ?? []) {
    if ((t.executionMode ?? 'inline') !== 'inline') continue;
    if (opts.reservedNames?.has(t.name)) continue;
    ctx[t.name] = llm.tool({
      description: t.description,
      // AgentTool parameters are stored as JSON Schema; the framework accepts
      // JSONSchema7 directly (ToolInputSchema = ProviderFormat | JSONSchema7).
      // The type is derived by indexing ToolContext because the llm namespace
      // does not re-export ToolInputSchema itself.
      parameters: t.parameters as unknown as llm.ToolContext[string]['parameters'],
      execute: async (args: unknown) => {
        opts.onExecuted?.(t.name, (args ?? {}) as Record<string, unknown>);
        return { status: 'recorded' };
      },
    });
  }
  return ctx;
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
