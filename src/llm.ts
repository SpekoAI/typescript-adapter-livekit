import {
  llm,
  DEFAULT_API_CONNECT_OPTIONS,
  type APIConnectOptions,
} from '@livekit/agents';
import type { ChatMessage as SpekoChatMessage, Speko } from '@spekoai/sdk';

import { type Intent, validateIntent } from './intent.js';

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
    const { messages, systemPrompt } = chatContextToSpeko(this.chatCtx);

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
        ...(systemPrompt !== undefined && { systemPrompt }),
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
 * Collapse a LiveKit `ChatContext` into Speko's `{ messages, systemPrompt }`
 * shape. All `system` / `developer` messages are concatenated with newlines
 * into `systemPrompt`; the remaining user / assistant messages become the
 * `messages` array in chronological order. Function-call and handoff items
 * are skipped — tools aren't supported by the proxy yet.
 */
export function chatContextToSpeko(ctx: llm.ChatContext): {
  messages: SpekoChatMessage[];
  systemPrompt?: string;
} {
  const systemParts: string[] = [];
  const messages: SpekoChatMessage[] = [];

  for (const item of ctx.items) {
    if (!(item instanceof llm.ChatMessage)) continue;
    const text = extractText(item);
    if (!text) continue;

    if (item.role === 'system' || item.role === 'developer') {
      systemParts.push(text);
      continue;
    }

    if (item.role === 'user' || item.role === 'assistant') {
      messages.push({ role: item.role, content: text });
    }
  }

  const systemPrompt = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;
  return systemPrompt !== undefined ? { messages, systemPrompt } : { messages };
}

function extractText(message: llm.ChatMessage): string {
  const text = message.textContent;
  return typeof text === 'string' ? text : '';
}
