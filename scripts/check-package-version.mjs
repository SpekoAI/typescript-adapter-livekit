import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeLogger } from '@livekit/agents';
import { SpekoSTT } from '../dist/index.js';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const marker = `${manifest.name}/${manifest.version}`;
console.log('Checking native factory arguments with expected synthetic rejections.');
initializeLogger({ pretty: false, level: 'silent' });

for (const sessionId of ['  synthetic-session  ', '   ', undefined]) {
  const calls = [];
  const stt = new SpekoSTT({
    speko: {},
    intent: { language: 'en' },
    streaming: true,
    baseUrl: 'https://adapter-version.invalid',
    apiKey: 'synthetic-version-check',
    sessionId,
    reconnect: { maxConsecutive: 0, maxLifetime: 0 },
    createWebSocket: (...args) => {
      calls.push(args);
      const socket = {
        readyState: 3,
        binaryType: 'arraybuffer',
        close() {},
        send() {
          throw new Error('Version check must not send audio');
        },
      };
      setImmediate(() => socket.onclose?.({ code: 1008, reason: 'Synthetic rejection' }));
      return socket;
    },
  });
  stt.on('error', () => {});
  const stream = stt.stream();
  const deadline = setTimeout(() => {
    throw new Error('Adapter version check did not finish');
  }, 2000);
  try {
    await stream.next();
    assert.deepEqual(
      calls,
      [
        [
          'wss://adapter-version.invalid/v1/transcribe/stream',
          {
            Authorization: 'Bearer synthetic-version-check',
            'User-Agent': marker,
            ...(sessionId?.trim() ? { 'x-session-id': sessionId.trim() } : {}),
          },
        ],
      ],
      'Adapter factory headers must match package.json and preserve auth/session arguments',
    );
  } finally {
    clearTimeout(deadline);
    stream.close();
  }
}
console.log(`Adapter request version matches package.json: ${marker}`);
