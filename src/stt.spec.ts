import { initializeLogger, stt } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import type { Speko, TranscribeOptions, TranscribeResult } from '@spekoai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWav } from './audio.js';
import {
  buildStreamingWavHeader,
  buildSttErrorEvent,
  DEFAULT_RECONNECT_POLICY,
  reconnectBackoffMs,
  SpekoSpeechStream,
  SpekoSTT,
  type WebSocketFactory,
} from './stt.js';

function makeFakeSpeko(result: TranscribeResult): {
  speko: Speko;
  transcribe: ReturnType<typeof vi.fn>;
} {
  const transcribe = vi.fn<
    (
      audio: Uint8Array,
      options: TranscribeOptions,
      abortSignal?: AbortSignal,
    ) => Promise<TranscribeResult>
  >(async () => result);
  return {
    speko: {
      transcribe,
      synthesize: vi.fn(),
      complete: vi.fn(),
      sessions: {} as unknown as Speko['sessions'],
      usage: {} as unknown as Speko['usage'],
    } as unknown as Speko,
    transcribe,
  };
}

function makeFrame(sampleRate = 16000): AudioFrame {
  const samples = new Int16Array([0, 1000, -1000, 2000, -2000, 0, 500, -500]);
  return new AudioFrame(samples, sampleRate, 1, samples.length);
}

describe('SpekoSTT', () => {
  it('forwards WAV bytes and intent to speko.transcribe', async () => {
    const { speko, transcribe } = makeFakeSpeko({
      text: 'hello world',
      provider: 'deepgram',
      model: 'nova-3',
      confidence: 0.91,
      failoverCount: 0,
      scoresRunId: null,
    });

    const sttInstance = new SpekoSTT({
      speko,
      intent: { language: 'en-US', optimizeFor: 'accuracy' },
    });

    const event = await sttInstance.recognize(makeFrame());

    expect(transcribe).toHaveBeenCalledOnce();
    const call = transcribe.mock.calls[0];
    if (!call) throw new Error('expected transcribe to be called');
    const [audioArg, optionsArg] = call;
    expect(optionsArg).toMatchObject({
      language: 'en-US',
      optimizeFor: 'accuracy',
      contentType: 'audio/wav',
    });

    const { sampleRate, channels } = parseWav(audioArg);
    expect(sampleRate).toBe(16000);
    expect(channels).toBe(1);

    expect(event.type).toBe(stt.SpeechEventType.FINAL_TRANSCRIPT);
    const [alt] = event.alternatives ?? [];
    expect(alt?.text).toBe('hello world');
    expect(alt?.confidence).toBe(0.91);
    expect(alt?.language).toBe('en-US');
  });

  it('defaults confidence to 1 when the proxy omits it', async () => {
    const { speko } = makeFakeSpeko({
      text: 'x',
      provider: 'deepgram',
      model: 'nova-3',
      confidence: null,
      failoverCount: 0,
      scoresRunId: null,
    });
    const sttInstance = new SpekoSTT({
      speko,
      intent: { language: 'en' },
    });
    const event = await sttInstance.recognize(makeFrame());
    expect(event.alternatives?.[0]?.confidence).toBe(1);
  });

  it('forwards the abort signal into speko.transcribe', async () => {
    const { speko, transcribe } = makeFakeSpeko({
      text: 'x',
      provider: 'deepgram',
      model: 'nova-3',
      confidence: 1,
      failoverCount: 0,
      scoresRunId: null,
    });
    const sttInstance = new SpekoSTT({
      speko,
      intent: { language: 'en' },
    });
    const controller = new AbortController();
    await sttInstance.recognize(makeFrame(), controller.signal);
    const call = transcribe.mock.calls[0];
    if (!call) throw new Error('expected transcribe to be called');
    expect(call[2]).toBe(controller.signal);
  });

  it('omits optimizeFor from the options when the intent does not set it', async () => {
    const { speko, transcribe } = makeFakeSpeko({
      text: 'x',
      provider: 'deepgram',
      model: 'nova-3',
      confidence: 1,
      failoverCount: 0,
      scoresRunId: null,
    });
    const sttInstance = new SpekoSTT({
      speko,
      intent: { language: 'en' },
    });
    await sttInstance.recognize(makeFrame());
    const call = transcribe.mock.calls[0];
    if (!call) throw new Error('expected transcribe to be called');
    expect(call[1]).not.toHaveProperty('optimizeFor');
  });

  it('throws a clear error when stream() is called directly', () => {
    const { speko } = makeFakeSpeko({
      text: '',
      provider: 'deepgram',
      model: 'nova-3',
      confidence: 1,
      failoverCount: 0,
      scoresRunId: null,
    });
    const sttInstance = new SpekoSTT({
      speko,
      intent: { language: 'en' },
    });
    expect(() => sttInstance.stream()).toThrow(/StreamAdapter/);
  });

  it('rejects an invalid intent at construction time', () => {
    const { speko } = makeFakeSpeko({
      text: '',
      provider: 'deepgram',
      model: 'nova-3',
      confidence: 1,
      failoverCount: 0,
      scoresRunId: null,
    });
    expect(
      () =>
        new SpekoSTT({
          speko,
          intent: {
            language: '' as unknown as string,
          },
        }),
    ).toThrow(/language/);
  });
});

describe('SpekoSTT streaming mode', () => {
  const base = { language: 'en' };

  it('batch mode declares streaming: false', () => {
    const { speko } = makeFakeSpeko({
      text: '',
      provider: 'deepgram',
      model: 'nova-3',
      confidence: 1,
      failoverCount: 0,
      scoresRunId: null,
    });
    const instance = new SpekoSTT({ speko, intent: base });
    expect(instance.capabilities.streaming).toBe(false);
  });

  it('streaming mode declares streaming: true', () => {
    const { speko } = makeFakeSpeko({
      text: '',
      provider: 'deepgram',
      model: 'nova-3',
      confidence: 1,
      failoverCount: 0,
      scoresRunId: null,
    });
    const instance = new SpekoSTT({
      speko,
      intent: base,
      streaming: true,
      baseUrl: 'https://api.speko.dev',
      apiKey: 'sk-test',
    });
    expect(instance.capabilities.streaming).toBe(true);
  });

  it('rejects streaming without baseUrl/apiKey', () => {
    const { speko } = makeFakeSpeko({
      text: '',
      provider: 'deepgram',
      model: 'nova-3',
      confidence: 1,
      failoverCount: 0,
      scoresRunId: null,
    });
    expect(() => new SpekoSTT({ speko, intent: base, streaming: true })).toThrow(/baseUrl|apiKey/);
  });
});

describe('buildStreamingWavHeader', () => {
  it('writes a 44-byte PCM16 header with streaming-sentinel sizes', () => {
    const header = buildStreamingWavHeader(16000, 1);
    expect(header.byteLength).toBe(44);
    const view = new DataView(header.buffer);
    expect(String.fromCharCode(...header.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...header.slice(8, 12))).toBe('WAVE');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint32(28, true)).toBe(32000); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits/sample
    expect(view.getUint32(4, true)).toBe(0xffffffff);
    expect(view.getUint32(40, true)).toBe(0xffffffff);
  });

  it('scales byteRate and blockAlign with channels', () => {
    const header = buildStreamingWavHeader(48000, 2);
    const view = new DataView(header.buffer);
    expect(view.getUint32(28, true)).toBe(192000);
    expect(view.getUint16(32, true)).toBe(4);
  });
});

describe('reconnectBackoffMs', () => {
  const policy = { baseDelayMs: 250, maxDelayMs: 5000 };

  it('grows exponentially and stays within the full-jitter band [exp/2, exp]', () => {
    // attempt 1 → exp 250 → [125, 250]; attempt 3 → exp 1000 → [500, 1000].
    expect(reconnectBackoffMs(1, policy, () => 0)).toBe(125);
    expect(reconnectBackoffMs(1, policy, () => 1)).toBe(250);
    expect(reconnectBackoffMs(3, policy, () => 0)).toBe(500);
    expect(reconnectBackoffMs(3, policy, () => 1)).toBe(1000);
  });

  it('caps at maxDelayMs no matter how high the attempt count', () => {
    // exp would be astronomically large; it must clamp to the ceiling.
    expect(reconnectBackoffMs(40, policy, () => 1)).toBe(5000);
    expect(reconnectBackoffMs(40, policy, () => 0)).toBe(2500);
  });

  it('never returns a delay below half the base or above the ceiling for any rng', () => {
    for (let attempt = 1; attempt <= 20; attempt++) {
      const v = reconnectBackoffMs(attempt, policy, () => Math.random());
      expect(v).toBeGreaterThanOrEqual(policy.baseDelayMs / 2);
      expect(v).toBeLessThanOrEqual(policy.maxDelayMs);
    }
  });
});

describe('buildSttErrorEvent', () => {
  it('builds a recoverable:false stt_error event the AgentSession can observe', () => {
    const err = new Error('boom');
    const ev = buildSttErrorEvent('speko.SpeechStream', err);
    expect(ev.type).toBe('stt_error');
    expect(ev.recoverable).toBe(false);
    expect(ev.label).toBe('speko.SpeechStream');
    expect(ev.error).toBe(err);
    expect(typeof ev.timestamp).toBe('number');
  });
});

describe('SpekoSpeechStream reconnect resilience', () => {
  const base = { language: 'en' };
  // Tiny delays so the reconnect/backoff loop runs fast; huge healthyMs so a
  // fast failure storm never resets the budget; short openTimeout never trips
  // because the fakes close on the next tick.
  const fastReconnect = {
    baseDelayMs: 1,
    maxDelayMs: 2,
    maxConsecutive: 2,
    healthyMs: 1_000_000,
    openTimeoutMs: 50,
  };

  // Plain object that structurally satisfies the WHATWG WebSocket surface the
  // stream drives; cast to WebSocket at the factory boundary.
  function fakeWs() {
    return {
      binaryType: 'blob',
      readyState: 0,
      send: () => {},
      close: () => {},
      onopen: null as ((ev?: unknown) => void) | null,
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      onerror: null as ((ev?: unknown) => void) | null,
      onclose: null as ((ev: { code: number; reason?: string }) => void) | null,
    };
  }

  function makeStreamingStt() {
    const { speko } = makeFakeSpeko({
      text: '',
      provider: 'deepgram',
      model: 'nova-3',
      confidence: 1,
      failoverCount: 0,
      scoresRunId: null,
    });
    return new SpekoSTT({
      speko,
      intent: base,
      streaming: true,
      baseUrl: 'https://api.speko.dev',
      apiKey: 'sk-test',
    });
  }

  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // The base SpeechStream constructor instantiates the framework logger, which
    // requires this in a unit context (no worker bootstrap runs it).
    initializeLogger({ pretty: false, level: 'fatal' });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it('uses production defaults (5 consecutive reconnects, 5s ceiling)', () => {
    expect(DEFAULT_RECONNECT_POLICY.maxConsecutive).toBe(5);
    expect(DEFAULT_RECONNECT_POLICY.maxDelayMs).toBe(5000);
  });

  it('surfaces a recoverable:false error to the session after reconnects are exhausted (no silent deafness)', async () => {
    const sttImpl = makeStreamingStt();
    const errors: { type: string; recoverable: boolean; error: Error }[] = [];
    sttImpl.on('error', (e) => errors.push(e));

    // Every socket drops before it opens with a TRANSIENT code (1006 abnormal) →
    // every attempt is reconnectable → the consecutive budget exhausts.
    const createWebSocket: WebSocketFactory = () => {
      const ws = fakeWs();
      setTimeout(() => ws.onclose?.({ code: 1006 }), 0);
      return ws as unknown as WebSocket;
    };

    const stream = new SpekoSpeechStream(sttImpl, {
      baseUrl: 'https://api.speko.dev',
      apiKey: 'sk-test',
      intent: base,
      constraints: undefined,
      keywords: undefined,
      createWebSocket,
      reconnect: fastReconnect,
    });

    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), {
      timeout: 3000,
      interval: 5,
    });
    expect(errors[0]?.type).toBe('stt_error');
    expect(errors[0]?.recoverable).toBe(false);
    expect(errors[0]?.error.message).toMatch(/permanently lost \(exhausted\)/);
    stream.close();
  });

  it('gives up IMMEDIATELY on a permanent close code (4401 auth) without burning the reconnect budget', async () => {
    const sttImpl = makeStreamingStt();
    const errors: { type: string; recoverable: boolean; error: Error }[] = [];
    sttImpl.on('error', (e) => errors.push(e));

    // 4401 = unauthorized (stale/revoked key). A retry can NEVER recover, so the
    // stream must fail fast — not reconnect 5x (~10-15s of caller-facing dead air)
    // before the inevitable give-up.
    let attempts = 0;
    const createWebSocket: WebSocketFactory = () => {
      attempts += 1;
      const ws = fakeWs();
      setTimeout(() => ws.onclose?.({ code: 4401 }), 0);
      return ws as unknown as WebSocket;
    };

    const stream = new SpekoSpeechStream(sttImpl, {
      baseUrl: 'https://api.speko.dev',
      apiKey: 'sk-test',
      intent: base,
      constraints: undefined,
      keywords: undefined,
      createWebSocket,
      reconnect: { ...fastReconnect, maxConsecutive: 5 },
    });

    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), {
      timeout: 3000,
      interval: 5,
    });
    expect(errors[0]?.recoverable).toBe(false);
    expect(errors[0]?.error.message).toMatch(/permanently lost \(permanent\)/);
    // The whole point: ONE connection attempt, no wasted reconnects on a dead key.
    expect(attempts).toBe(1);
    stream.close();
  });

  it('gives up via the lifetime cap when a flap never trips the consecutive budget (#13)', async () => {
    const sttImpl = makeStreamingStt();
    const errors: { type: string; recoverable: boolean; error: Error }[] = [];
    sttImpl.on('error', (e) => errors.push(e));

    // maxConsecutive huge so it never trips; only the lifetime cap can stop an
    // endless transient flap.
    let attempts = 0;
    const createWebSocket: WebSocketFactory = () => {
      attempts += 1;
      const ws = fakeWs();
      setTimeout(() => ws.onclose?.({ code: 1006 }), 0);
      return ws as unknown as WebSocket;
    };

    const stream = new SpekoSpeechStream(sttImpl, {
      baseUrl: 'https://api.speko.dev',
      apiKey: 'sk-test',
      intent: base,
      constraints: undefined,
      keywords: undefined,
      createWebSocket,
      reconnect: {
        baseDelayMs: 1,
        maxDelayMs: 2,
        maxConsecutive: 1000,
        healthyMs: 0,
        openTimeoutMs: 50,
        maxLifetime: 3,
      },
    });

    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), {
      timeout: 3000,
      interval: 5,
    });
    expect(errors[0]?.recoverable).toBe(false);
    expect(errors[0]?.error.message).toMatch(/permanently lost \(flapping\)/);
    // initial attempt + maxLifetime(3) reconnects, then it gives up.
    expect(attempts).toBeLessThanOrEqual(5);
    stream.close();
  });

  it('recovers from a transient socket drop without deafening the call (reconnects, emits transcript, no error)', async () => {
    const sttImpl = makeStreamingStt();
    const errors: unknown[] = [];
    sttImpl.on('error', (e) => errors.push(e));

    let attempt = 0;
    const createWebSocket: WebSocketFactory = () => {
      attempt += 1;
      const ws = fakeWs();
      if (attempt === 1) {
        // First socket drops mid-handshake (transient blip).
        setTimeout(() => ws.onclose?.({ code: 1006 }), 0);
      } else {
        // Second socket connects, transcribes, and ends cleanly.
        setTimeout(() => {
          ws.readyState = 1; // OPEN
          ws.onopen?.();
          ws.onmessage?.({
            data: JSON.stringify({ type: 'ready', provider: 'deepgram', model: 'nova-3' }),
          });
          ws.onmessage?.({
            data: JSON.stringify({
              type: 'transcript',
              text: 'hello world',
              isFinal: true,
              confidence: 0.9,
            }),
          });
          ws.onclose?.({ code: 1000 });
        }, 0);
      }
      return ws as unknown as WebSocket;
    };

    const stream = new SpekoSpeechStream(sttImpl, {
      baseUrl: 'https://api.speko.dev',
      apiKey: 'sk-test',
      intent: base,
      constraints: undefined,
      keywords: undefined,
      createWebSocket,
      reconnect: { ...fastReconnect, maxConsecutive: 5 },
    });

    const got: stt.SpeechEvent[] = [];
    const reader = (async () => {
      for await (const ev of stream) got.push(ev);
    })();

    await vi.waitFor(
      () => expect(got.some((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)).toBe(true),
      { timeout: 3000, interval: 5 },
    );
    stream.close();
    await reader;

    expect(attempt).toBeGreaterThanOrEqual(2); // it really did reconnect
    expect(errors).toHaveLength(0); // a transient drop must NOT surface a fatal error
    const final = got.find((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT);
    expect(final?.alternatives?.[0]?.text).toBe('hello world');
  });

  it('gives up instead of reconnecting forever when connections carry no audio (SPE-121)', async () => {
    const sttImpl = makeStreamingStt();
    const errors: { type: string; recoverable: boolean; error: Error }[] = [];
    sttImpl.on('error', (e) => errors.push(e));

    let attempts = 0;
    // Every socket drops without ever carrying audio. With `healthyMs: 0`, EVERY
    // failure "survives the healthy window" — so the ONLY thing standing between
    // this and an infinite reconnect loop is the new `&& audioPumped` guard.
    // Pre-fix (reset on survival alone) this is the exact SPE-121 prod pathology:
    // a no-audio stream 1011s at the idle timeout, resets the budget, and
    // reconnects forever (heavy 1011 spam, even on idle workers). Post-fix the
    // budget climbs and the stream gives up after maxConsecutive.
    const createWebSocket: WebSocketFactory = () => {
      attempts += 1;
      const ws = fakeWs();
      setTimeout(() => ws.onclose?.({ code: 1011, reason: 'all_providers_failed' }), 0);
      return ws as unknown as WebSocket;
    };

    const stream = new SpekoSpeechStream(sttImpl, {
      baseUrl: 'https://api.speko.dev',
      apiKey: 'sk-test',
      intent: base,
      constraints: undefined,
      keywords: undefined,
      createWebSocket,
      reconnect: {
        baseDelayMs: 1,
        maxDelayMs: 2,
        maxConsecutive: 3,
        healthyMs: 0,
        openTimeoutMs: 50,
      },
    });

    // The stream must GIVE UP (surface a fatal error) rather than loop forever.
    // Pre-fix this never fires (infinite reconnect) → the waitFor times out.
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), {
      timeout: 3000,
      interval: 5,
    });
    expect(errors[0]?.recoverable).toBe(false);
    expect(errors[0]?.error.message).toMatch(/permanently lost/);
    stream.close();

    // Bounded: 1 initial attempt + maxConsecutive(3) reconnects. A reset-on-
    // survival loop would have called this an unbounded number of times.
    expect(attempts).toBeLessThanOrEqual(4);
  });
});

describe('SpekoSpeechStream flush-endpoint (SPEKO_NAVAI_FLUSH_ENDPOINT)', () => {
  const base = { language: 'en' };
  const fastReconnect = {
    baseDelayMs: 1,
    maxDelayMs: 2,
    maxConsecutive: 2,
    healthyMs: 1_000_000,
    openTimeoutMs: 50,
  };

  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    initializeLogger({ pretty: false, level: 'fatal' });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    delete process.env.SPEKO_NAVAI_FLUSH_ENDPOINT;
  });

  function streamingStt() {
    const { speko } = makeFakeSpeko({
      text: '',
      provider: 'navai',
      model: 'navai-uz',
      confidence: 1,
      failoverCount: 0,
      scoresRunId: null,
    });
    return new SpekoSTT({
      speko,
      intent: base,
      streaming: true,
      baseUrl: 'https://api.speko.dev',
      apiKey: 'sk-test',
    });
  }

  // A fake socket that opens on the next tick and captures TEXT frames sent.
  function openingWsFactory(sent: string[]): WebSocketFactory {
    return () => {
      const ws = {
        binaryType: 'blob',
        readyState: 0,
        send: (d: unknown) => {
          if (typeof d === 'string') sent.push(d);
        },
        close: () => {},
        onopen: null as ((ev?: unknown) => void) | null,
        onmessage: null as ((ev: { data: unknown }) => void) | null,
        onerror: null as ((ev?: unknown) => void) | null,
        onclose: null as ((ev: { code: number; reason?: string }) => void) | null,
      };
      setTimeout(() => {
        ws.readyState = 1;
        ws.onopen?.();
      }, 0);
      return ws as unknown as WebSocket;
    };
  }

  function makeStream(sent: string[]) {
    return new SpekoSpeechStream(streamingStt(), {
      baseUrl: 'https://api.speko.dev',
      apiKey: 'sk-test',
      intent: base,
      constraints: undefined,
      keywords: undefined,
      createWebSocket: openingWsFactory(sent),
      reconnect: fastReconnect,
    });
  }

  const hasFrame = (sent: string[], type: string) =>
    sent.some((s) => {
      try {
        return (JSON.parse(s) as { type?: string }).type === type;
      } catch {
        return false;
      }
    });

  it('forwards a flush as {type:"flush"} when the flag is on', async () => {
    process.env.SPEKO_NAVAI_FLUSH_ENDPOINT = 'true';
    const sent: string[] = [];
    const stream = makeStream(sent);
    await vi.waitFor(() => expect(hasFrame(sent, 'config')).toBe(true), {
      timeout: 1000,
      interval: 5,
    });
    stream.flush(); // enqueues the framework's FLUSH_SENTINEL
    await vi.waitFor(() => expect(hasFrame(sent, 'flush')).toBe(true), {
      timeout: 1000,
      interval: 5,
    });
    stream.close();
  });

  it('does NOT send a flush frame when the flag is off (unchanged behavior)', async () => {
    delete process.env.SPEKO_NAVAI_FLUSH_ENDPOINT;
    const sent: string[] = [];
    const stream = makeStream(sent);
    await vi.waitFor(() => expect(hasFrame(sent, 'config')).toBe(true), {
      timeout: 1000,
      interval: 5,
    });
    stream.flush();
    await new Promise((r) => setTimeout(r, 60)); // let pumpAudio drain the sentinel
    expect(hasFrame(sent, 'flush')).toBe(false);
    stream.close();
  });
});

// Word-aligned streams feed LiveKit's adaptive interruption detector, which
// (a) needs interim results so words arrive DURING overlap, and (b) treats a
// `startTime === endTime === 0` alternative as "no timestamps" and discards
// the ENTIRE buffer of user speech held during agent playback
// (audio_recognition flushHeldTranscripts) — so 0/0 must never be emitted on
// an aligned stream.
describe('SpekoSpeechStream word-aligned emission', () => {
  const base = { language: 'en' };
  const fastReconnect = {
    baseDelayMs: 1,
    maxDelayMs: 2,
    maxConsecutive: 2,
    healthyMs: 1_000_000,
    openTimeoutMs: 50,
  };

  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    initializeLogger({ pretty: false, level: 'fatal' });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  function streamingStt() {
    const { speko } = makeFakeSpeko({
      text: '',
      provider: 'deepgram',
      model: 'nova-3',
      confidence: 1,
      failoverCount: 0,
      scoresRunId: null,
    });
    return new SpekoSTT({
      speko,
      intent: base,
      streaming: true,
      baseUrl: 'https://api.speko.dev',
      apiKey: 'sk-test',
    });
  }

  // Opens on the next tick, replies `ready`, then delivers the given frames.
  function frameDeliveringWs(frames: readonly object[], sent: string[]): WebSocketFactory {
    return () => {
      const ws = {
        binaryType: 'blob',
        readyState: 0,
        send: (d: unknown) => {
          if (typeof d === 'string') sent.push(d);
        },
        close: () => {},
        onopen: null as ((ev?: unknown) => void) | null,
        onmessage: null as ((ev: { data: unknown }) => void) | null,
        onerror: null as ((ev?: unknown) => void) | null,
        onclose: null as ((ev: { code: number; reason?: string }) => void) | null,
      };
      setTimeout(() => {
        ws.readyState = 1;
        ws.onopen?.();
        ws.onmessage?.({
          data: JSON.stringify({ type: 'ready', provider: 'deepgram', model: 'nova-3' }),
        });
        for (const frame of frames) ws.onmessage?.({ data: JSON.stringify(frame) });
      }, 0);
      return ws as unknown as WebSocket;
    };
  }

  function makeStream(options: { aligned: boolean; frames: readonly object[]; sent?: string[] }): {
    stream: SpekoSpeechStream;
    sent: string[];
  } {
    const sent = options.sent ?? [];
    const stream = new SpekoSpeechStream(streamingStt(), {
      baseUrl: 'https://api.speko.dev',
      apiKey: 'sk-test',
      intent: base,
      constraints: undefined,
      keywords: undefined,
      alignedTranscript: options.aligned,
      createWebSocket: frameDeliveringWs(options.frames, sent),
      reconnect: fastReconnect,
      // Frozen clock → connection offset 0 → emitted timings are exactly the
      // provider's, keeping the assertions below deterministic.
      now: () => 0,
    });
    return { stream, sent };
  }

  function parseConfigFrame(sent: string[]): Record<string, unknown> | undefined {
    for (const s of sent) {
      try {
        const parsed = JSON.parse(s) as { type?: string };
        if (parsed.type === 'config') return parsed as Record<string, unknown>;
      } catch {
        // binary/audio frames
      }
    }
    return undefined;
  }

  const wordedFinal = {
    type: 'transcript',
    text: 'hello world',
    isFinal: true,
    confidence: 0.9,
    words: [
      { text: 'hello', start: 1.5, end: 2.0, confidence: 0.9 },
      { text: 'world', start: 2.0, end: 2.5, confidence: 0.9 },
    ],
  };
  const emptyWordlessFinal = { type: 'transcript', text: '', isFinal: true, confidence: 0 };

  it('requests interim results in the config frame on an aligned stream (and not otherwise)', async () => {
    const aligned = makeStream({ aligned: true, frames: [] });
    await vi.waitFor(() => expect(parseConfigFrame(aligned.sent)).toBeDefined(), {
      timeout: 1000,
      interval: 5,
    });
    expect(parseConfigFrame(aligned.sent)?.interimResults).toBe(true);
    aligned.stream.close();

    const plain = makeStream({ aligned: false, frames: [] });
    await vi.waitFor(() => expect(parseConfigFrame(plain.sent)).toBeDefined(), {
      timeout: 1000,
      interval: 5,
    });
    expect(parseConfigFrame(plain.sent)).not.toHaveProperty('interimResults');
    plain.stream.close();
  });

  it('aligned: skips words-less empty finals outside speech (the held-buffer nuke) but still emits real transcripts', async () => {
    const { stream } = makeStream({
      aligned: true,
      frames: [emptyWordlessFinal, wordedFinal],
    });
    const got: stt.SpeechEvent[] = [];
    const reader = (async () => {
      for await (const ev of stream) got.push(ev);
    })();

    await vi.waitFor(
      () => expect(got.some((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)).toBe(true),
      { timeout: 3000, interval: 5 },
    );
    stream.close();
    await reader;

    const finals = got.filter((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT);
    expect(finals).toHaveLength(1); // the empty final was dropped, not emitted as ''
    expect(finals[0]?.alternatives?.[0]?.text).toBe('hello world');
    expect(finals[0]?.alternatives?.[0]?.startTime).toBe(1.5);
    expect(finals[0]?.alternatives?.[0]?.endTime).toBe(2.5);
    expect(got.filter((e) => e.type === stt.SpeechEventType.START_OF_SPEECH)).toHaveLength(1);
  });

  it('aligned: stamps words-less non-empty frames at the session clock — never the 0/0 sentinel, even before any worded frame', async () => {
    // ElevenLabs realtime interims carry text but no words; before this guard
    // the FIRST such frame of a call was stamped 0/0 (nothing seen yet).
    const clock = { t: 0 };
    const sent: string[] = [];
    const createWebSocket: WebSocketFactory = () => {
      const ws = {
        binaryType: 'blob',
        readyState: 0,
        send: (d: unknown) => {
          if (typeof d === 'string') sent.push(d);
        },
        close: () => {},
        onopen: null as ((ev?: unknown) => void) | null,
        onmessage: null as ((ev: { data: unknown }) => void) | null,
        onerror: null as ((ev?: unknown) => void) | null,
        onclose: null as ((ev: { code: number; reason?: string }) => void) | null,
      };
      setTimeout(() => {
        clock.t += 100; // connect latency
        ws.readyState = 1;
        ws.onopen?.();
        ws.onmessage?.({
          data: JSON.stringify({ type: 'ready', provider: 'elevenlabs', model: 'scribe-rt' }),
        });
        clock.t += 5_000; // 5s into the call, user speaks
        ws.onmessage?.({
          data: JSON.stringify({
            type: 'transcript',
            text: 'uh huh',
            isFinal: true,
            confidence: 0.5,
          }),
        });
      }, 0);
      return ws as unknown as WebSocket;
    };
    const stream = new SpekoSpeechStream(streamingStt(), {
      baseUrl: 'https://api.speko.dev',
      apiKey: 'sk-test',
      intent: base,
      constraints: undefined,
      keywords: undefined,
      alignedTranscript: true,
      createWebSocket,
      reconnect: fastReconnect,
      now: () => clock.t,
    });
    const got: stt.SpeechEvent[] = [];
    const reader = (async () => {
      for await (const ev of stream) got.push(ev);
    })();

    await vi.waitFor(
      () => expect(got.some((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)).toBe(true),
      { timeout: 3000, interval: 5 },
    );
    stream.close();
    await reader;

    const wordless = got.find((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)
      ?.alternatives?.[0];
    expect(wordless?.text).toBe('uh huh');
    // Session-clock stamp (5.1s in), NOT the 0/0 sentinel.
    expect(wordless?.startTime).toBe(5.1);
    expect(wordless?.endTime).toBe(5.1);
  });

  it('aligned: rebases provider word timings onto the session clock across reconnects', async () => {
    // Provider word clocks restart at ~0 on every gateway connection, but the
    // reconnect is invisible to LiveKit, whose echo ignore-window is
    // session-scoped — un-rebased times would map post-reconnect barge-ins
    // into the deep past and get them discarded.
    const clock = { t: 0 };
    let attempt = 0;
    const createWebSocket: WebSocketFactory = () => {
      attempt += 1;
      const ws = {
        binaryType: 'blob',
        readyState: 0,
        send: () => {},
        close: () => {},
        onopen: null as ((ev?: unknown) => void) | null,
        onmessage: null as ((ev: { data: unknown }) => void) | null,
        onerror: null as ((ev?: unknown) => void) | null,
        onclose: null as ((ev: { code: number; reason?: string }) => void) | null,
      };
      if (attempt === 1) {
        // First connection dies 1s into the call (transient blip).
        setTimeout(() => {
          clock.t = 1_000;
          ws.onclose?.({ code: 1006 });
        }, 0);
      } else {
        setTimeout(() => {
          clock.t = 120_000; // reconnected 2 minutes into the session
          ws.readyState = 1;
          ws.onopen?.();
          ws.onmessage?.({
            data: JSON.stringify({ type: 'ready', provider: 'deepgram', model: 'nova-3' }),
          });
          ws.onmessage?.({ data: JSON.stringify(wordedFinal) }); // provider clock restarted: words at 1.5-2.5
        }, 0);
      }
      return ws as unknown as WebSocket;
    };
    const stream = new SpekoSpeechStream(streamingStt(), {
      baseUrl: 'https://api.speko.dev',
      apiKey: 'sk-test',
      intent: base,
      constraints: undefined,
      keywords: undefined,
      alignedTranscript: true,
      createWebSocket,
      reconnect: { ...fastReconnect, maxConsecutive: 5 },
      now: () => clock.t,
    });
    const got: stt.SpeechEvent[] = [];
    const reader = (async () => {
      for await (const ev of stream) got.push(ev);
    })();

    await vi.waitFor(
      () => expect(got.some((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)).toBe(true),
      { timeout: 3000, interval: 5 },
    );
    stream.close();
    await reader;

    const final = got.find((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)
      ?.alternatives?.[0];
    // 1.5-2.5s on the NEW connection's clock → 121.5-122.5s of session time.
    expect(final?.startTime).toBe(121.5);
    expect(final?.endTime).toBe(122.5);
    expect(final?.words?.[0]?.startTime).toBe(121.5);
    expect(final?.words?.[1]?.endTime).toBe(122.5);
  });

  it('non-aligned: keeps the legacy behavior (empty finals emitted with 0/0)', async () => {
    const { stream } = makeStream({ aligned: false, frames: [emptyWordlessFinal] });
    const got: stt.SpeechEvent[] = [];
    const reader = (async () => {
      for await (const ev of stream) got.push(ev);
    })();

    await vi.waitFor(
      () => expect(got.some((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)).toBe(true),
      { timeout: 3000, interval: 5 },
    );
    stream.close();
    await reader;

    const final = got.find((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT);
    expect(final?.alternatives?.[0]?.text).toBe('');
    expect(final?.alternatives?.[0]?.startTime).toBe(0);
    expect(final?.alternatives?.[0]?.endTime).toBe(0);
  });
});
