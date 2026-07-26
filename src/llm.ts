import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS, llm, log } from '@livekit/agents';
import type {
  ChatTool,
  ChatToolChoice,
  CompleteParams,
  PipelineConstraints,
  Speko,
  ChatMessage as SpekoChatMessage,
} from '@spekoai/sdk';

import { isAbortError, SpekoAdapterError, toFrameworkApiError } from './errors.js';
import { type Intent, validateIntent } from './intent.js';
import { mergeTools, RegisteredToolsLoader } from './registered-tools.js';

// Defined in errors.ts (so the audio/TTS paths can raise coded faults without
// pulling in this module) and re-exported here to keep the import path that
// callers and `index.ts` already use.
export { SpekoAdapterError };

export interface SpekoLLMGenerationInfo {
  epoch: number;
  at: number;
}

export interface SpekoLLMOptions {
  speko: Speko;
  intent: Intent;
  /** Active voice session id, forwarded to server-executed tools. */
  sessionId?: string;
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
  /**
   * Called when a new `.chat()` stream is created. Epochs are per SpekoLLM
   * instance and strictly increase from 1.
   */
  onGenerationStarted?: (info: SpekoLLMGenerationInfo) => void;
  /**
   * Called when a `.chat()` stream exits through the framework abort path
   * (typically barge-in). Not called for completed or faulted generations.
   */
  onGenerationAborted?: (info: SpekoLLMGenerationInfo) => void;
}

type VoiceCompleteParams = CompleteParams & { readonly voiceOptimized: true };

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
  readonly #sessionId: string | undefined;
  readonly #temperature?: number;
  readonly #maxTokens?: number;
  readonly #constraints: PipelineConstraints | undefined;
  readonly #sessionTools: readonly ChatTool[] | undefined;
  readonly #registeredLoader: RegisteredToolsLoader | undefined;
  readonly #onGenerationStarted: ((info: SpekoLLMGenerationInfo) => void) | undefined;
  readonly #onGenerationAborted: ((info: SpekoLLMGenerationInfo) => void) | undefined;
  #generationEpoch = 0;

  constructor(options: SpekoLLMOptions) {
    super();
    validateIntent(options.intent);
    this.#speko = options.speko;
    this.#intent = options.intent;
    this.#sessionId = options.sessionId;
    this.#temperature = options.temperature;
    this.#maxTokens = options.maxTokens;
    this.#constraints = options.constraints;
    this.#sessionTools = options.tools;
    this.#onGenerationStarted = options.onGenerationStarted;
    this.#onGenerationAborted = options.onGenerationAborted;

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
    toolCtx?: llm.ToolContextLike;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): llm.LLMStream {
    const generation = this.#nextGeneration();
    return new SpekoLLMStream(this, {
      generation,
      chatCtx: params.chatCtx,
      toolCtx: params.toolCtx,
      toolChoice: params.toolChoice,
      parallelToolCalls: params.parallelToolCalls,
      connOptions: params.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
      speko: this.#speko,
      intent: this.#intent,
      sessionId: this.#sessionId,
      temperature: this.#temperature,
      maxTokens: this.#maxTokens,
      constraints: this.#constraints,
      registeredLoader: this.#registeredLoader,
      sessionTools: this.#sessionTools,
      onGenerationAborted: this.#onGenerationAborted,
    });
  }

  #nextGeneration(): SpekoLLMGenerationInfo {
    const generation = { epoch: (this.#generationEpoch += 1), at: Date.now() };
    if (this.#onGenerationStarted !== undefined) {
      try {
        this.#onGenerationStarted(generation);
      } catch (err) {
        log().warn(
          { error: err instanceof Error ? err.message : String(err), epoch: generation.epoch },
          '[SpekoLLM] generation-start-hook:error',
        );
      }
    }
    return generation;
  }
}

interface SpekoLLMStreamArgs {
  generation: SpekoLLMGenerationInfo;
  chatCtx: llm.ChatContext;
  toolCtx?: llm.ToolContextLike;
  toolChoice?: llm.ToolChoice;
  parallelToolCalls?: boolean;
  connOptions: APIConnectOptions;
  speko: Speko;
  intent: Intent;
  sessionId?: string;
  temperature?: number;
  maxTokens?: number;
  constraints?: PipelineConstraints;
  registeredLoader?: RegisteredToolsLoader;
  sessionTools?: readonly ChatTool[];
  onGenerationAborted?: (info: SpekoLLMGenerationInfo) => void;
}

class SpekoLLMStream extends llm.LLMStream {
  readonly #speko: Speko;
  readonly #intent: Intent;
  readonly #sessionId: string | undefined;
  readonly #temperature?: number;
  readonly #maxTokens?: number;
  readonly #constraints: PipelineConstraints | undefined;
  readonly #sessionTools: readonly ChatTool[] | undefined;
  readonly #toolChoice: llm.ToolChoice | undefined;
  readonly #parallelToolCalls: boolean | undefined;
  readonly #registeredLoader: RegisteredToolsLoader | undefined;
  readonly #generation: SpekoLLMGenerationInfo;
  readonly #onGenerationAborted: ((info: SpekoLLMGenerationInfo) => void) | undefined;

  constructor(parent: SpekoLLM, args: SpekoLLMStreamArgs) {
    super(parent, {
      chatCtx: args.chatCtx,
      toolCtx: args.toolCtx,
      connOptions: args.connOptions,
    });
    this.#speko = args.speko;
    this.#intent = args.intent;
    this.#sessionId = args.sessionId;
    this.#temperature = args.temperature;
    this.#maxTokens = args.maxTokens;
    this.#constraints = args.constraints;
    this.#sessionTools = args.sessionTools;
    this.#toolChoice = args.toolChoice;
    this.#parallelToolCalls = args.parallelToolCalls;
    this.#registeredLoader = args.registeredLoader;
    this.#generation = args.generation;
    this.#onGenerationAborted = args.onGenerationAborted;
  }

  protected async run(): Promise<void> {
    try {
      await this.#complete();
    } catch (err) {
      // A VAD/turn-commit abort is normal mid-utterance: the framework calls
      // abortController.abort() when it detects new user speech, cancelling the
      // in-flight /v1/complete. Returning cleanly lets the next turn proceed.
      if (this.abortController.signal.aborted || isAbortError(err)) {
        if (isAbortError(err)) {
          log().info('[SpekoLLM] complete:aborted (barge-in)');
        } else {
          // Aborted, but a NON-abort fault surfaced during teardown. Don't
          // rethrow (the turn is already cancelled) but don't hide it either —
          // a genuine fault during barge-in teardown must stay visible (#20).
          log().warn(
            { error: err instanceof Error ? err.message : String(err) },
            '[SpekoLLM] complete:error-during-abort',
          );
        }
        this.#notifyGenerationAborted();
        return;
      }
      // Otherwise hand the framework a classified APIError so its maxRetry loop
      // runs: transient gateway faults (429/5xx/STREAM_ENDED/EMPTY_COMPLETION)
      // re-issue the turn (the router can fail over); only a permanent fault
      // (401 auth, INVALID_CONTEXT) surfaces recoverable:false. A bare Error
      // here would skip retries and close the session on the first blip.
      throw toFrameworkApiError(err);
    }
  }

  #notifyGenerationAborted(): void {
    if (this.#onGenerationAborted === undefined) return;
    try {
      this.#onGenerationAborted({ epoch: this.#generation.epoch, at: Date.now() });
    } catch (err) {
      log().warn(
        {
          error: err instanceof Error ? err.message : String(err),
          epoch: this.#generation.epoch,
        },
        '[SpekoLLM] generation-abort-hook:error',
      );
    }
  }

  async #complete(): Promise<void> {
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

    const completeParams: VoiceCompleteParams = {
      messages,
      intent: {
        language: this.#intent.language,
        ...(this.#intent.region !== undefined && { region: this.#intent.region }),
        ...(this.#intent.optimizeFor !== undefined && {
          optimizeFor: this.#intent.optimizeFor,
        }),
      },
      voiceOptimized: true,
      ...(this.#sessionId !== undefined && { sessionId: this.#sessionId }),
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
      // Log only genuine faults here (with requestId/elapsed context); the
      // run() wrapper owns abort handling (clean return) and fault
      // classification (wrap into a retryable/permanent APIError).
      if (!(this.abortController.signal.aborted || isAbortError(err))) {
        logger.error(
          {
            requestId,
            elapsedMs: Date.now() - t0,
            error: err instanceof Error ? err.message : String(err),
          },
          '[SpekoLLM] complete:error',
        );
      }
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
function toolCtxToSpekoTools(toolCtx: llm.ToolContextLike | undefined): ChatTool[] | undefined {
  if (!toolCtx) return undefined;
  // `ToolContext` is a class as of @livekit/agents 1.5 — Object.entries on the
  // instance would iterate its private fields and silently drop every tool, so
  // normalize first and read the name→tool map via the functionTools getter.
  const entries = Object.entries(llm.toToolContext(toolCtx).functionTools);
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
