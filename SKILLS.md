# @spekoai/adapter-livekit — skill sheet

Dense reference for an LLM wiring Speko into a **LiveKit Agents** worker.
If you're on the browser side, use `@spekoai/client`. If you're writing
plain server calls, use `@spekoai/sdk` directly.

## When to use

Pick `@spekoai/adapter-livekit` when you're building a LiveKit Agents
worker (`@livekit/agents`) and want STT, LLM, and TTS routed through
Speko's `/v1/transcribe`, `/v1/complete`, `/v1/synthesize` — so you
don't ship provider API keys on the worker side and get failover for
free.

## Install

```bash
bun add @spekoai/sdk @spekoai/adapter-livekit \
        @livekit/agents @livekit/agents-plugin-silero @livekit/rtc-node
```

`@livekit/agents`, `@livekit/rtc-node`, and
`@livekit/agents-plugin-silero` (for VAD) are **peer deps** — you pin the
versions you want to run against. Node 20+.

## Environment

- `SPEKO_API_KEY` — from `https://dashboard.speko.ai/api-keys`.
- Standard LiveKit worker vars: `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
  `LIVEKIT_API_SECRET`.

## Minimal snippet

```ts
import {
  type JobContext, type JobProcess, ServerOptions, cli, defineAgent, voice,
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
      intent: { language: 'en-US', optimizeFor: 'balanced' },
    });

    const session = new voice.AgentSession({ vad, stt, llm, tts });
    await session.start({
      agent: new voice.Agent({ instructions: 'Be a concise voice assistant.' }),
      room: ctx.room,
    });
    await ctx.connect();
    session.generateReply({ instructions: 'Greet the user.' });
  },
});

cli.runApp(new ServerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName: 'speko-demo',
}));
```

## Public surface

- `createSpekoComponents(opts) -> { stt, llm, tts }` — the high-level
  helper. Returns STT wrapped in `stt.StreamAdapter(vad)` and TTS wrapped
  in `tts.StreamAdapter(sentenceTokenizer)` so Speko's buffered proxy
  plugs into a streaming `voice.AgentSession`.
- Lower-level classes for when you want control:
  `SpekoSTT`, `SpekoLLM`, `SpekoTTS`.
- Helpers: `audioToWav`, `wavToAudio` — encoding utilities used by the
  STT path.
- Types: `Intent`, `SpekoLLMOptions`, `SpekoTTSOptions`,
  `CreateSpekoComponentsOptions`.

## `createSpekoComponents` options

| Option              | Type                          | Notes                                                                       |
| ------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `speko`             | `Speko`                       | Initialized client from `@spekoai/sdk`.                                     |
| `vad`               | `VAD`                         | Typically `await silero.VAD.load()`.                                        |
| `intent`            | `Intent`                      | `{ language, optimizeFor? }`.                                               |
| `voice?`            | `string`                      | TTS voice override.                                                         |
| `constraints?`      | `PipelineConstraints`         | Per-modality provider allowlist (shared across STT/LLM/TTS).                |
| `sentenceTokenizer?`| `tokenize.SentenceTokenizer`  | Defaults to `tokenize.basic.SentenceTokenizer`.                             |
| `llm?`              | `{ temperature?, maxTokens? }`| Completion tuning.                                                          |
| `ttsOptions?`       | `{ sampleRate?, speed? }`     | TTS tuning.                                                                 |

## Limitations (v1)

- **Buffered, not end-to-end streaming.** Each STT call waits for
  end-of-utterance (VAD-segmented); each LLM call returns a single
  completion; each TTS call synthesizes one sentence at a time. Latency
  is acceptable for voice UX but interruption-detection is less snappy
  than a streaming-native plugin.
- **No tool / function calls.** `/v1/complete` doesn't expose tools yet.
  Passing a non-empty `toolCtx` logs a warning and is ignored.
- **TTS output format.** Adapter accepts `audio/pcm;rate=NNNN` (Cartesia)
  and `audio/wav`; throws on `audio/mpeg`. For v1, pick a routing intent
  that prefers Cartesia (e.g. add a `constraints.allowedProviders.tts`
  allowlist of `["cartesia"]`).
- **STT input format.** Mono PCM16. Sample rate is inferred from the
  incoming `AudioFrame`.

## Common gotchas

- **VAD is required.** `createSpekoComponents` expects a loaded VAD;
  load it in `prewarm` and stash on `proc.userData` so the model file
  isn't reloaded per room.
- **MP3 TTS throws.** If the router picks ElevenLabs, the adapter rejects
  the stream. Constrain TTS to Cartesia or WAV-emitting providers:
  `constraints: { allowedProviders: { tts: ['cartesia'] } }`.
- **Peer deps must match.** If `@livekit/agents` in your app is a
  different major than what this adapter was built against, you'll see
  type errors. Align with the adapter's README.
- **Don't construct `Speko` inside `entry`.** Create it once at module
  scope — reusing the HTTP client keepalives is free perf.

## See also

- README: `spekoai://docs/adapter-livekit-readme`
- Server SDK: `spekoai://docs/sdk-skills`
- Scaffold: prompt `scaffold_project` with `scenario=livekit_agent`.
