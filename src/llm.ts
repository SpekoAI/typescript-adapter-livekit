import {
  llm,
  DEFAULT_API_CONNECT_OPTIONS,
  type APIConnectOptions,
} from '@livekit/agents';
import type { ChatMessage as SpekoChatMessage, Speko } from '@spekoai/sdk';

import { type Intent, validateIntent } from './intent.js';

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
}

/**
 * LiveKit Agents LLM adapter that delegates completion to the Speko proxy
 * (`POST /v1/complete`). The router picks the best LLM provider per intent
 * and fails over automatically.
 *
 * v1 is non-streaming: each `.chat()` call yields exactly one `ChatChunk`
 * with the full assistant response. Tool calls are not supported by the
 * `/v1/complete` endpoint yet — any `toolCtx` passed in is logged and
 * ignored.
 */
export class SpekoLLM extends llm.LLM {
  readonly #speko: Speko;
  readonly #intent: Intent;
  readonly #temperature?: number;
  readonly #maxTokens?: number;
  #warnedAboutTools = false;

  constructor(options: SpekoLLMOptions) {
    super();
    validateIntent(options.intent);
    this.#speko = options.speko;
    this.#intent = options.intent;
    this.#temperature = options.temperature;
    this.#maxTokens = options.maxTokens;
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
    if (params.toolCtx && Object.keys(params.toolCtx).length > 0 && !this.#warnedAboutTools) {
      this.#warnedAboutTools = true;
      console.warn(
        'SpekoLLM: tool calls are not supported in v1 — `toolCtx` is being ignored. ' +
          'Remove tools from the agent or wait for streaming LLM proxy support.',
      );
    }

    return new SpekoLLMStream(this, {
      chatCtx: params.chatCtx,
      toolCtx: params.toolCtx,
      connOptions: params.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
      speko: this.#speko,
      intent: this.#intent,
      temperature: this.#temperature,
      maxTokens: this.#maxTokens,
    });
  }
}

interface SpekoLLMStreamArgs {
  chatCtx: llm.ChatContext;
  toolCtx?: llm.ToolContext;
  connOptions: APIConnectOptions;
  speko: Speko;
  intent: Intent;
  temperature?: number;
  maxTokens?: number;
}

class SpekoLLMStream extends llm.LLMStream {
  readonly #speko: Speko;
  readonly #intent: Intent;
  readonly #temperature?: number;
  readonly #maxTokens?: number;

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
  }

  protected async run(): Promise<void> {
    const messages = chatContextToSpeko(this.chatCtx);
    if (messages.length === 0) {
      throw new SpekoAdapterError(
        'SpekoLLM: ChatContext produced no convertible messages',
        'INVALID_CONTEXT',
      );
    }

    const result = await this.#speko.complete(
      {
        messages,
        intent: {
          language: this.#intent.language,
          vertical: this.#intent.vertical,
          ...(this.#intent.optimizeFor !== undefined && {
            optimizeFor: this.#intent.optimizeFor,
          }),
        },
        ...(this.#temperature !== undefined && { temperature: this.#temperature }),
        ...(this.#maxTokens !== undefined && { maxTokens: this.#maxTokens }),
      },
      this.abortController.signal,
    );

    this.queue.put({
      id: crypto.randomUUID(),
      delta: {
        role: 'assistant',
        content: result.text,
      },
      usage: {
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        promptCachedTokens: 0,
        totalTokens: result.usage.promptTokens + result.usage.completionTokens,
      },
    });
  }
}

/**
 * Flatten a LiveKit `ChatContext` into Speko's `messages` array. System and
 * developer items are emitted inline as `role: 'system'`; function-call and
 * handoff items are skipped. Ordering is preserved.
 */
export function chatContextToSpeko(ctx: llm.ChatContext): SpekoChatMessage[] {
  const messages: SpekoChatMessage[] = [];

  for (const item of ctx.items) {
    if (!(item instanceof llm.ChatMessage)) continue;
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
  }

  return messages;
}

function extractText(message: llm.ChatMessage): string {
  const text = message.textContent;
  return typeof text === 'string' ? text : '';
}
