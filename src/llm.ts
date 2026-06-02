import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS, llm, log } from '@livekit/agents';
import type {
  ChatTool,
  ChatToolChoice,
  PipelineConstraints,
  Speko,
  ChatMessage as SpekoChatMessage,
} from '@spekoai/sdk';

import { type Intent, validateIntent } from './intent.js';
import { mergeTools, RegisteredToolsLoader } from './registered-tools.js';

export class SpekoAdapterError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'SpekoAdapterError';
    this.code = code;
  }
}

export interface SpekoLLMOptions {
  speko: Speko;
  intent: Intent;
  /** Forwarded to the proxy; defaults to the upstream model's default. */
  temperature?: number;
  /** Forwarded to the proxy; defaults to the upstream model's default. */
  maxTokens?: number;
  /** Optional allow-list constraints. */
  constraints?: PipelineConstraints;
  /** Optional per-session tool declarations supplied by runtime call config. */
  tools?: readonly ChatTool[];
  /**
   * When set, the adapter loads tools registered for `agentId` via
   * `speko.agents.tools.listChatTools(agentId)` once per session and merges
   * them with whatever LiveKit's `ToolContext` provides. Registered tools win
   * on name collision. Omit `agentId` to keep the v0.3 behavior (LiveKit-runtime
   * tools only).
   */
  agentId?: string;
  /**
   * @deprecated Ignored. The loader now reads the base URL from the `speko`
   * client. Configure it on the `Speko` client instead.
   */
  apiBaseUrl?: string;
  /**
   * @deprecated Ignored. The loader now reads the API key from the `speko`
   * client. Configure it on the `Speko` client instead.
   */
  apiKey?: string;
  /**
   * Called once if the registered-tools fetch fails. Voice session keeps
   * running with runtime-only tools — this is a soft degradation.
   */
  onRegisteredToolsError?: (err: Error) => void;
}

/**
 * LiveKit Agents LLM adapter that delegates completion to the Speko proxy
 * (`POST /v1/complete`). The router picks the best LLM provider per intent
 * and fails over automatically.
 *
 * Each `.chat()` call streams text deltas as the proxy emits them, and yields
 * tool calls at the end when the model invokes tools.
 */
export class SpekoLLM extends llm.LLM {
  readonly #speko: Speko;
  readonly #intent: Intent;
  readonly #temperature?: number;
  readonly #maxTokens?: number;
  readonly #constraints: PipelineConstraints | undefined;
  readonly #sessionTools: readonly ChatTool[] | undefined;
  readonly #registeredLoader: RegisteredToolsLoader | undefined;

  constructor(options: SpekoLLMOptions) {
    super();
    validateIntent(options.intent);
    this.#speko = options.speko;
    this.#intent = options.intent;
    this.#temperature = options.temperature;
    this.#maxTokens = options.maxTokens;
    this.#constraints = options.constraints;
    this.#sessionTools = options.tools;

    if (options.agentId) {
      this.#registeredLoader = new RegisteredToolsLoader({
        speko: options.speko,
        agentId: options.agentId,
        ...(options.onRegisteredToolsError && {
          onError: options.onRegisteredToolsError,
        }),
      });
      void this.#registeredLoader.load();
    } else {
      this.#registeredLoader = undefined;
    }
  }

  override label(): string {
    return 'speko.LLM';
  }

  override get provider(): string {
    return 'speko';
  }

  override get model(): string {
    return 'speko-router';
  }

  override chat(params: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): llm.LLMStream {
    return new SpekoLLMStream(this, {
      chatCtx: params.chatCtx,
      toolCtx: params.toolCtx,
      toolChoice: params.toolChoice,
      parallelToolCalls: params.parallelToolCalls,
      connOptions: params.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
      speko: this.#speko,
      intent: this.#intent,
      temperature: this.#temperature,
      maxTokens: this.#maxTokens,
      constraints: this.#constraints,
      registeredLoader: this.#registeredLoader,
      sessionTools: this.#sessionTools,
    });
  }
}

interface SpekoLLMStreamArgs {
  chatCtx: llm.ChatContext;
  toolCtx?: llm.ToolContext;
  toolChoice?: llm.ToolChoice;
  parallelToolCalls?: boolean;
  connOptions: APIConnectOptions;
  speko: Speko;
  intent: Intent;
  temperature?: number;
  maxTokens?: number;
  constraints?: PipelineConstraints;
  registeredLoader?: RegisteredToolsLoader;
  sessionTools?: readonly ChatTool[];
}

class SpekoLLMStream extends llm.LLMStream {
  readonly #speko: Speko;
  readonly #intent: Intent;
  readonly #temperature?: number;
  readonly #maxTokens?: number;
  readonly #constraints: PipelineConstraints | undefined;
  readonly #sessionTools: readonly ChatTool[] | undefined;
  readonly #toolChoice: llm.ToolChoice | undefined;
  readonly #parallelToolCalls: boolean | undefined;
  readonly #registeredLoader: RegisteredToolsLoader | undefined;

  constructor(parent: SpekoLLM, args: SpekoLLMStreamArgs) {
    super(parent, {
      chatCtx: args.chatCtx,
      toolCtx: args.toolCtx,
      connOptions: args.connOptions,
    });
    this.#speko = args.speko;
    this.#intent = args.intent;
    this.#temperature = args.temperature;
    this.#maxTokens = args.maxTokens;
    this.#constraints = args.constraints;
    this.#sessionTools = args.sessionTools;
    this.#toolChoice = args.toolChoice;
    this.#parallelToolCalls = args.parallelToolCalls;
    this.#registeredLoader = args.registeredLoader;
  }

  protected async run(): Promise<void> {
    // Diagnostic logging mirrors SpekoTTS: the LiveKit framework consumes
    // an LLMStream silently if `run()` returns without ever calling
    // `queue.put()`, so without these logs the symptom is a session that
    // emits "Creating speech handle" and then nothing — no error, no audio.
    // Grep the worker container for `[SpekoLLM]` to see the per-turn timeline.
    const logger = log();
    const requestId = crypto.randomUUID();
    const t0 = Date.now();

    const messages = chatContextToSpeko(this.chatCtx);
    if (messages.length === 0) {
      logger.error(
        { requestId, chatCtxItems: this.chatCtx.items.length },
        '[SpekoLLM] complete:invalid-context',
      );
      throw new SpekoAdapterError(
        'SpekoLLM: ChatContext produced no convertible messages',
        'INVALID_CONTEXT',
      );
    }

    const runtimeTools = toolCtxToSpekoTools(this.toolCtx);
    const registeredTools = this.#registeredLoader
      ? await this.#registeredLoader.load()
      : undefined;
    const configuredTools = mergeTools(this.#sessionTools, registeredTools);
    const tools = mergeTools(configuredTools, runtimeTools);

    logger.info(
      {
        requestId,
        messageCount: messages.length,
        lastRole: messages[messages.length - 1]?.role,
        language: this.#intent.language,
        optimizeFor: this.#intent.optimizeFor,
        constraints: this.#constraints,
        toolCount: tools?.length ?? 0,
        registeredToolCount: registeredTools?.length ?? 0,
        sessionToolCount: this.#sessionTools?.length ?? 0,
        runtimeToolCount: runtimeTools?.length ?? 0,
      },
      '[SpekoLLM] complete:start',
    );

    const completeParams = {
      messages,
      intent: {
        language: this.#intent.language,
        ...(this.#intent.region !== undefined && { region: this.#intent.region }),
        ...(this.#intent.optimizeFor !== undefined && {
          optimizeFor: this.#intent.optimizeFor,
        }),
      },
      ...(this.#temperature !== undefined && { temperature: this.#temperature }),
      ...(this.#maxTokens !== undefined && { maxTokens: this.#maxTokens }),
      ...(this.#constraints !== undefined && { constraints: this.#constraints }),
      ...(tools !== undefined && { tools }),
      ...(this.#toolChoice !== undefined && {
        toolChoice: this.#toolChoice as ChatToolChoice,
      }),
      ...(this.#parallelToolCalls !== undefined && {
        parallelToolCalls: this.#parallelToolCalls,
      }),
    };

    let done:
      | {
          text: string;
          provider: string;
          model: string;
          usage: { promptTokens: number; completionTokens: number };
          failoverCount: number;
          toolCalls?: Array<{ id: string; name: string; args: string }>;
        }
      | undefined;
    let streamedTextLength = 0;
    try {
      for await (const event of this.#speko.completeStream(
        completeParams,
        this.abortController.signal,
      )) {
        if (event.type === 'delta') {
          streamedTextLength += event.text.length;
          this.queue.put({
            id: crypto.randomUUID(),
            delta: {
              role: 'assistant',
              content: event.text,
            },
          });
        } else if (event.type === 'done') {
          done = event;
        } else if (event.type === 'error') {
          throw new SpekoAdapterError(event.error, event.code);
        }
      }
    } catch (err) {
      // VAD-triggered abort is normal mid-utterance: the framework calls
      // `abortController.abort()` when it detects new user speech, which
      // cancels the in-flight /v1/complete request. Returning cleanly
      // lets the session continue with the next turn. Without this catch,
      // the AbortError propagates as a fatal `llm_error` and the entire
      // AgentSession closes.
      if (this.abortController.signal.aborted) {
        logger.info({ requestId, elapsedMs: Date.now() - t0 }, '[SpekoLLM] complete:aborted');
        return;
      }
      logger.error(
        {
          requestId,
          elapsedMs: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        },
        '[SpekoLLM] complete:error',
      );
      throw err;
    }

    if (!done) {
      throw new SpekoAdapterError(
        'SpekoLLM: complete stream ended without a done event',
        'STREAM_ENDED',
      );
    }

    const toolCalls =
      done.toolCalls && done.toolCalls.length > 0
        ? done.toolCalls.map((tc) =>
            llm.FunctionCall.create({ callId: tc.id, name: tc.name, args: tc.args }),
          )
        : undefined;

    logger.info(
      {
        requestId,
        elapsedMs: Date.now() - t0,
        provider: done.provider,
        model: done.model,
        textLength: done.text?.length ?? 0,
        streamedTextLength,
        toolCallCount: toolCalls?.length ?? 0,
        failoverCount: done.failoverCount,
        promptTokens: done.usage.promptTokens,
        completionTokens: done.usage.completionTokens,
      },
      '[SpekoLLM] complete:response',
    );

    // Empty completion (no text AND no tool calls) is a router-side fault
    // we don't want to swallow. Without this check the framework consumes
    // a content-less assistant delta, never invokes TTS, and the session
    // appears frozen with no error. Throwing here surfaces the failure to
    // the AgentSession's Error handler so it's visible in worker logs.
    const hasText = typeof done.text === 'string' && done.text.length > 0;
    if (!hasText && toolCalls === undefined) {
      logger.error(
        {
          requestId,
          elapsedMs: Date.now() - t0,
          provider: done.provider,
          model: done.model,
        },
        '[SpekoLLM] complete:empty-result',
      );
      throw new SpekoAdapterError(
        `SpekoLLM: ${done.provider}/${done.model} returned no text and no tool calls`,
        'EMPTY_COMPLETION',
      );
    }

    if (toolCalls !== undefined) {
      this.queue.put({
        id: crypto.randomUUID(),
        delta: {
          role: 'assistant',
          toolCalls,
        },
      });
    }

    this.queue.put({
      id: crypto.randomUUID(),
      delta: {
        role: 'assistant',
      },
      usage: {
        promptTokens: done.usage.promptTokens,
        completionTokens: done.usage.completionTokens,
        promptCachedTokens: 0,
        totalTokens: done.usage.promptTokens + done.usage.completionTokens,
      },
    });

    logger.info(
      {
        requestId,
        contentLength: hasText ? done.text.length : 0,
        toolCallCount: toolCalls?.length ?? 0,
      },
      '[SpekoLLM] queue:put',
    );
  }
}

/**
 * Convert a LiveKit `ToolContext` into the SDK's `ChatTool[]` shape. Returns
 * `undefined` when there are no tools so the proxy receives a clean payload.
 * Schemas are emitted as legacy (non-strict) JSON Schema; the proxy applies
 * provider-specific strict-mode adjustments.
 */
function toolCtxToSpekoTools(toolCtx: llm.ToolContext | undefined): ChatTool[] | undefined {
  if (!toolCtx) return undefined;
  const entries = Object.entries(toolCtx);
  if (entries.length === 0) return undefined;

  const tools: ChatTool[] = [];
  for (const [name, fn] of entries) {
    if (!llm.isFunctionTool(fn)) continue;
    tools.push({
      name,
      description: fn.description,
      parameters: llm.toJsonSchema(fn.parameters, false, false) as Record<string, unknown>,
    });
  }
  return tools.length > 0 ? tools : undefined;
}

/**
 * Flatten a LiveKit `ChatContext` into Speko's `messages` array. System and
 * developer items are emitted inline as `role: 'system'`. `FunctionCall`
 * items become assistant messages with `toolCalls`; `FunctionCallOutput`
 * items become `role: 'tool'` messages with `toolCallId`. Handoff items are
 * skipped. Ordering is preserved.
 */
export function chatContextToSpeko(ctx: llm.ChatContext): SpekoChatMessage[] {
  const messages: SpekoChatMessage[] = [];

  for (const item of ctx.items) {
    if (item instanceof llm.ChatMessage) {
      const text = extractText(item);
      if (!text) continue;

      const role =
        item.role === 'developer'
          ? 'system'
          : item.role === 'system' || item.role === 'user' || item.role === 'assistant'
            ? item.role
            : undefined;
      if (role === undefined) continue;

      messages.push({ role, content: text });
      continue;
    }

    if (item instanceof llm.FunctionCall) {
      messages.push({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: item.callId, name: item.name, args: item.args }],
      });
      continue;
    }

    if (item instanceof llm.FunctionCallOutput) {
      messages.push({
        role: 'tool',
        content: item.output,
        toolCallId: item.callId,
        ...(item.isError && { isError: true }),
      });
    }
  }

  return messages;
}

function extractText(message: llm.ChatMessage): string {
  const text = message.textContent;
  return typeof text === 'string' ? text : '';
}
