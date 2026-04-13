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

const speko = new Speko({
  apiKey: process.env.SPEKO_API_KEY!,
  baseUrl: process.env.SPEKO_BASE_URL ?? 'https://api.speko.ai',
});

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
        vertical: 'general',
        optimizeFor: 'latency',
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
