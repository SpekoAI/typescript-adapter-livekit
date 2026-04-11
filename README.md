# @speko/adapter-livekit

> **Coming soon.** This package is currently a scaffolded placeholder.

LiveKit adapter for Speko — drop into your existing LiveKit agent worker
and have Speko's router pick the best STT, LLM, and TTS provider per call.
Failover handled.

```ts
// Future API (not yet implemented)
import { runSpekoAgent } from '@speko/adapter-livekit';
import { Speko } from '@speko/sdk';

const speko = new Speko({ apiKey: process.env.SPEKO_API_KEY });

runSpekoAgent({
  speko,
  intent: { language: 'es-MX', vertical: 'healthcare' },
});
```

Track progress: <https://github.com/SpekoAI/platform>
