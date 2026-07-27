# @spekoai/adapter-livekit

LiveKit Agents adapter for [Speko](https://speko.ai) - run your own LiveKit
agent worker and have Speko's router pick the best STT, LLM, and TTS provider
per call. Failover is handled server-side; you don't ship provider API keys.

## Install

```sh
npm install @spekoai/sdk @spekoai/adapter-livekit \
            @livekit/agents @livekit/agents-plugin-silero @livekit/rtc-node
```

`@livekit/agents` and `@livekit/rtc-node` are declared as peer dependencies so
you control the version you run against.

## Usage

```ts
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  voice,
} from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import { Speko } from '@spekoai/sdk';
import { createSpekoComponents } from '@spekoai/adapter-livekit';
import { fileURLToPath } from 'node:url';

const SPEKO_API_KEY = process.env.SPEKO_API_KEY!;
const SPEKO_BASE_URL = process.env.SPEKO_BASE_URL ?? 'https://api.speko.dev';

const speko = new Speko({ apiKey: SPEKO_API_KEY, baseUrl: SPEKO_BASE_URL });

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const vad = ctx.proc.userData.vad as silero.VAD;

    const { stt, llm, tts } = createSpekoComponents({
      speko,
      vad,
      intent: {
        language: 'en-US',
        optimizeFor: 'balanced',
      },
      // Streaming STT is the default and opens its own WebSocket, so it needs
      // the base URL and key explicitly: the Speko client keeps both private.
      // Drop these two lines only if you also set `sttStreaming: false`.
      sttBaseUrl: SPEKO_BASE_URL,
      sttApiKey: SPEKO_API_KEY,
    });

    const session = new voice.AgentSession({ vad, stt, llm, tts });

    await session.start({
      agent: new voice.Agent({
        instructions: 'You are a helpful voice assistant. Be concise.',
      }),
      room: ctx.room,
    });

    await ctx.connect();

    session.generateReply({
      instructions: 'Greet the user and offer your assistance.',
    });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'speko-demo',
  }),
);
```

`createSpekoComponents` returns `{ stt, llm, tts }` ready to drop into a
`voice.AgentSession`. By default `stt` is a native streaming `SpekoSTT` over
`GET /v1/transcribe/stream`; `tts` is `SpekoTTS` wrapped with
[`tts.StreamAdapter`](https://docs.livekit.io/agents/) + a sentence tokenizer.
Pass `sttStreaming: false` to get the older VAD-bounded batch STT wrapped in
`stt.StreamAdapter` instead, in which case `sttBaseUrl`/`sttApiKey` are not
needed.

If you want more control, you can use the classes directly:

```ts
import { SpekoSTT, SpekoLLM, SpekoTTS } from '@spekoai/adapter-livekit';
import { stt, tts, tokenize } from '@livekit/agents';

// Streaming STT: drop straight into the session, no StreamAdapter.
const streamingSTT = new SpekoSTT({
  speko,
  intent,
  streaming: true,
  baseUrl: SPEKO_BASE_URL,
  apiKey: SPEKO_API_KEY,
});

// Batch STT: constructing SpekoSTT directly defaults to the VAD-bounded path,
// which must be wrapped.
const batchSTT = new SpekoSTT({ speko, intent });
const wrappedSTT = new stt.StreamAdapter(batchSTT, vad);

const spekoLLM = new SpekoLLM({ speko, intent, temperature: 0.7 });

// `voice` is a provider voice id, not a model name. Fetch ids from
// `GET /v1/voices`; the one below is Cartesia's "Katie (American female)".
const spekoTTS = new SpekoTTS({
  speko,
  intent,
  voice: 'f786b574-daa5-4673-aa0c-cbe3e8534c02',
});
const wrappedTTS = new tts.StreamAdapter(
  spekoTTS,
  new tokenize.basic.SentenceTokenizer(),
);
```

## Behavior and limits (v1)

- **STT streams by default.** `createSpekoComponents` opens a native WebSocket
  to `GET /v1/transcribe/stream` and emits interim + final transcripts as the
  provider produces them; your VAD is still used for turn detection. The older
  VAD-bounded path (one WAV per utterance to `POST /v1/transcribe`) is behind
  `sttStreaming: false`, and is also what you get when you construct `SpekoSTT`
  directly without `streaming: true`.
- **TTS is sentence-bounded in LiveKit.** `/v1/synthesize` streams audio bytes,
  while `tts.StreamAdapter` still splits assistant text into sentences before
  calling Speko.
- **Tool calls are supported through `/v1/complete`.** Inline tools return to
  the LiveKit runtime; registered webhook/builtin tools can be executed by the
  Speko server and folded into the next provider turn.
- **TTS output format.** The adapter accepts `audio/pcm;rate=NNNN` (Cartesia)
  and `audio/wav`. It throws on `audio/mpeg` (ElevenLabs MP3) - for v1, pick
  a routing intent that prefers Cartesia, or ask Speko to normalise output
  to PCM server-side before you upgrade.
- **TTS output sample rate.** Whatever rate the routed provider produces (24 kHz
  for most, 48 kHz for Hume and Gradium, 16 kHz for Amazon Polly) is resampled
  to the `sampleRate` the TTS advertises, so the declared rate is always what
  LiveKit receives. Matching rates cost nothing.
- **STT input format.** Mono PCM16. The adapter encodes whatever sample rate
  the LiveKit `AudioFrame` carries into the WAV header it uploads; Speko / the
  downstream STT providers handle resampling.

## Development

```sh
# from the monorepo root
pnpm install
pnpm nx run @spekoai/adapter-livekit:typecheck
pnpm nx run @spekoai/adapter-livekit:build
pnpm nx run @spekoai/adapter-livekit:test
```

### Smoke test against a local proxy

1. Start the Speko server: `npx nx run @spekoai/server:serve`.
2. Scaffold a LiveKit agent outside the monorepo (or in `scratch/`) with
   `lk agent init my-agent --template agent-starter-node`.
3. Link this package with `npm link` (or copy the snippet above into the
   `agent.ts` file).
4. Set `SPEKO_API_KEY` against your local server and run `pnpm dev`.
5. Open the LiveKit Agents Playground, connect, and speak - you should see the
   full STT -> LLM -> TTS round-trip flowing through the Speko proxy.
