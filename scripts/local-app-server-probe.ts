import path from 'node:path';
import { CodexAppClient, createStderrLogger } from '../src/providers/codex/app_client.js';
import { loadCodexProfilesFromEnv } from '../src/providers/codex/config.js';

const cwd = path.resolve(process.env.CODEXBRIDGE_DEFAULT_CWD ?? process.cwd());
const { profiles } = loadCodexProfilesFromEnv();
const profile = profiles.find((entry) => entry.id === 'openai-default');

if (!profile) {
  throw new Error('openai-default provider profile is missing');
}

const client = new CodexAppClient({
  codexCliBin: String(profile.config.cliBin),
  codexCliArgs: Array.isArray(profile.config.codexCliArgs) ? profile.config.codexCliArgs : [],
  launchCommand: typeof profile.config.launchCommand === 'string' ? profile.config.launchCommand : null,
  autolaunch: profile.config.autolaunch === true,
  modelCatalog: Array.isArray(profile.config.modelCatalog) ? profile.config.modelCatalog : [],
  modelCatalogMode: profile.config.modelCatalogMode === 'overlay-only' ? 'overlay-only' : 'merge',
  logger: createStderrLogger(),
});

try {
  await client.start();
  const threads = await client.listThreads({ limit: 10 });
  if (threads.items.length === 0) {
    throw new Error('Codex app-server returned no desktop sessions');
  }
  const models = await client.listModels();
  const model = models.find((entry) => entry.isDefault)?.model ?? models[0]?.model ?? null;
  if (!model) {
    throw new Error('Codex app-server returned no available model');
  }

  const probeThread = await client.startThread({
    cwd,
    title: 'CodexBridge app-server probe',
    model,
    ephemeral: true,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
  });
  const turn = await client.startTurn({
    threadId: probeThread.threadId,
    inputText: 'Reply with exactly CODEXBRIDGE_APP_SERVER_OK and no other text.',
    cwd,
    model,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    timeoutMs: 120_000,
  });

  const outputText = String(turn.outputText ?? '').trim();
  if (turn.outputState !== 'complete' || outputText !== 'CODEXBRIDGE_APP_SERVER_OK') {
    throw new Error(`Unexpected probe result: state=${turn.outputState}, output=${JSON.stringify(outputText)}`);
  }

  process.stdout.write(`${JSON.stringify({
    connected: true,
    transport: process.env.CODEX_APP_SERVER_TRANSPORT ?? 'auto',
    codexHome: process.env.CODEX_HOME ?? null,
    listedThreads: threads.items.length,
    model,
    latestThread: threads.items[0] ?? null,
    probeThreadId: probeThread.threadId,
    probeOutput: outputText,
  }, null, 2)}\n`);
} finally {
  await client.stop();
}
