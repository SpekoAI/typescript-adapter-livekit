# @spekoai/adapter-livekit

LiveKit Agents adapter for [Speko](https://speko.ai) — run your own LiveKit
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

const speko = new Speko({ apiKey: process.env.SPEKO_API_KEY! });

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

`createSpekoComponents` wraps `SpekoSTT` with
[`stt.StreamAdapter`](https://docs.livekit.io/agents/) + your VAD and wraps
`SpekoTTS` with `tts.StreamAdapter` + a sentence tokenizer, so Speko's
streaming REST proxy plugs cleanly into a streaming `voice.AgentSession`.

If you want more control, you can use the classes directly:

```ts
import { SpekoSTT, SpekoLLM, SpekoTTS } from '@spekoai/adapter-livekit';
import { stt, tts, tokenize } from '@livekit/agents';

const spekoSTT = new SpekoSTT({ speko, intent });
const wrappedSTT = new stt.StreamAdapter(spekoSTT, vad);

const spekoLLM = new SpekoLLM({ speko, intent, temperature: 0.7 });

const spekoTTS = new SpekoTTS({ speko, intent, voice: 'sonic-english' });
const wrappedTTS = new tts.StreamAdapter(
  spekoTTS,
  new tokenize.basic.SentenceTokenizer(),
);
```

## Limitations (v1)

- **STT request upload is still utterance-bounded.** `/v1/transcribe` streams
  transcript events back, but this adapter still uses VAD to upload one WAV per
  utterance rather than full-duplex microphone audio.
- **TTS is sentence-bounded in LiveKit.** `/v1/synthesize` streams audio bytes,
  while `tts.StreamAdapter` still splits assistant text into sentences before
  calling Speko.
- **Tool calls are supported through `/v1/complete`.** Inline tools return to
  the LiveKit runtime; registered webhook/builtin tools can be executed by the
  Speko server and folded into the next provider turn.
- **TTS output format.** The adapter accepts `audio/pcm;rate=NNNN` (Cartesia)
  and `audio/wav`. It throws on `audio/mpeg` (ElevenLabs MP3) — for v1, pick
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
5. Open the LiveKit Agents Playground, connect, and speak — you should see the
   full STT → LLM → TTS round-trip flowing through the Speko proxy.
