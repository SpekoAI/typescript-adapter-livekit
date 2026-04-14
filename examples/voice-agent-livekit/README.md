# Voice agent (LiveKit) example

A runnable LiveKit Agents worker that routes STT → LLM → TTS through the Speko
gateway via [`@spekoai/adapter-livekit`](../../README.md). Bring your own
LiveKit Cloud project (or self-hosted LiveKit) — the Speko server no longer
holds LiveKit credentials.

## Prerequisites

1. **Speko API key.** Generate one in the dashboard (`/api-keys`).
2. **Provider keys uploaded.** Deepgram, OpenAI, and Cartesia keys must be
   set in the dashboard's `/byok` page — the router only picks
   providers whose credentials are stored.
3. **LiveKit project.** Get `LIVEKIT_URL` / `LIVEKIT_API_KEY` /
   `LIVEKIT_API_SECRET` from https://cloud.livekit.io (or your self-hosted
   install).

## Run

```bash
cp .env.example .env     # fill in the blanks
pnpm install             # from the monorepo root
pnpm --filter @spekoai-examples/voice-agent-livekit dev
```

The worker registers under `agentName: speko-demo`. Open
<https://agents-playground.livekit.io>, connect with your LiveKit URL + key
pair, and start talking.

## MP3 caveat

`@spekoai/adapter-livekit` throws on `audio/mpeg` (ElevenLabs). This example
sets `optimizeFor: 'latency'` to bias the router toward Cartesia, which emits
`audio/pcm`. If you still hit an MP3 error, edit
`fixtures/benchmarks/scores.v1.json` to put Cartesia ahead of ElevenLabs for
`(en-US, general)` on the server side.
