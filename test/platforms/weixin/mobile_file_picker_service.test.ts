import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MobileFilePickerService,
  resolveAdvertisedHost,
} from '../../../src/platforms/weixin/mobile_file_picker_service.js';
import type { InboundTextEvent } from '../../../src/types/platform.js';

async function createTestService(options: {
  now?: () => number;
  ttlMs?: number;
  maxFileBytes?: number;
  maxFiles?: number;
  miniProgramUrlTemplate?: string;
  miniProgramAppId?: string;
  miniProgramAppSecret?: string;
  miniProgramApiBaseUrl?: string;
} = {}) {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexbridge-mobile-picker-'));
  let resolveEvent: ((event: InboundTextEvent) => void) | null = null;
  const receivedEvent = new Promise<InboundTextEvent>((resolve) => {
    resolveEvent = resolve;
  });
  const service = new MobileFilePickerService({
    rootDir,
    host: '127.0.0.1',
    port: 0,
    onUpload: async (event) => resolveEvent?.(event),
    ...options,
  });
  await service.start();
  return {
    rootDir,
    service,
    receivedEvent,
    async dispose() {
      await service.stop();
      await fsp.rm(rootDir, { recursive: true, force: true });
    },
  };
}

function createWeixinEvent(): InboundTextEvent {
  return {
    platform: 'weixin',
    externalScopeId: 'wxid_mobile_picker',
    text: '/pickfile',
    locale: 'zh-CN',
    metadata: { source: 'test' },
  };
}

test('mobile file picker renders an explicit system picker fallback and submits selected files to the originating WeChat scope', async () => {
  const harness = await createTestService();
  try {
    const link = await harness.service.createUploadSession(createWeixinEvent(), '总结这个文件');
    assert.match(link.url, /^http:\/\/127\.0\.0\.1:\d+\/mobile-upload\/[a-f0-9]{64}$/u);

    const page = await fetch(link.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /type="file"/u);
    assert.match(html, /multiple/u);
    assert.match(html, /系统文件选择器回退页面/u);
    assert.equal(link.picker, 'system_file_picker');

    const body = Buffer.from('hello from mobile');
    const upload = await fetch(`${link.url}/files?name=${encodeURIComponent('报告.txt')}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': String(body.length) },
      body,
    });
    assert.equal(upload.status, 201);

    const complete = await fetch(`${link.url}/complete`, { method: 'POST' });
    assert.equal(complete.status, 202);
    const event = await harness.receivedEvent;
    assert.equal(event.platform, 'weixin');
    assert.equal(event.externalScopeId, 'wxid_mobile_picker');
    assert.equal(event.text, '总结这个文件');
    assert.equal(event.attachments?.length, 1);
    assert.equal(event.attachments?.[0].kind, 'file');
    assert.equal(event.attachments?.[0].fileName, '报告.txt');
    assert.equal(event.attachments?.[0].mimeType, 'text/plain');
    assert.deepEqual(await fsp.readFile(event.attachments?.[0].localPath ?? ''), body);
    assert.equal((event.metadata?.mobileFilePicker as any)?.source, 'android_saf');

    const reused = await fetch(link.url);
    assert.equal(reused.status, 410);
  } finally {
    await harness.dispose();
  }
});

test('mobile file picker advertises a physical LAN address ahead of WSL and VMware adapters', () => {
  const interfaces = {
    'vEthernet (WSL)': [{
      address: '172.24.240.1',
      netmask: '255.255.240.0',
      family: 'IPv4' as const,
      mac: '00:00:00:00:00:01',
      internal: false,
      cidr: '172.24.240.1/20',
    }],
    'VMware Network Adapter VMnet8': [{
      address: '192.168.186.1',
      netmask: '255.255.255.0',
      family: 'IPv4' as const,
      mac: '00:00:00:00:00:02',
      internal: false,
      cidr: '192.168.186.1/24',
    }],
    WLAN: [{
      address: '192.168.1.5',
      netmask: '255.255.255.0',
      family: 'IPv4' as const,
      mac: '00:00:00:00:00:03',
      internal: false,
      cidr: '192.168.1.5/24',
    }],
  };

  assert.equal(resolveAdvertisedHost('0.0.0.0', interfaces), '192.168.1.5');
  assert.equal(resolveAdvertisedHost('127.0.0.1', interfaces), '127.0.0.1');
});

test('mobile file picker expires tokens and rejects unknown tokens', async () => {
  let now = 1_000;
  const harness = await createTestService({ now: () => now, ttlMs: 50 });
  try {
    const link = await harness.service.createUploadSession(createWeixinEvent());
    now += 51;
    assert.equal((await fetch(link.url)).status, 410);
    const unknownUrl = link.url.replace(/[a-f0-9]{64}$/u, 'f'.repeat(64));
    assert.equal((await fetch(unknownUrl)).status, 410);
  } finally {
    await harness.dispose();
  }
});

test('mobile file picker sanitizes traversal filenames and keeps files inside its root', async () => {
  const harness = await createTestService();
  try {
    const link = await harness.service.createUploadSession(createWeixinEvent());
    const upload = await fetch(`${link.url}/files?name=${encodeURIComponent('..\\..\\secret.txt')}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: 'safe',
    });
    assert.equal(upload.status, 201);
    assert.equal((await fetch(`${link.url}/complete`, { method: 'POST' })).status, 202);
    const event = await harness.receivedEvent;
    const attachment = event.attachments?.[0];
    assert.equal(attachment?.fileName, 'secret.txt');
    assert.equal(path.relative(harness.rootDir, attachment?.localPath ?? '').startsWith('..'), false);
  } finally {
    await harness.dispose();
  }
});

test('mobile file picker enforces file size and count limits', async () => {
  const harness = await createTestService({ maxFileBytes: 4, maxFiles: 1 });
  try {
    const link = await harness.service.createUploadSession(createWeixinEvent());
    const tooLarge = await fetch(`${link.url}/files?name=large.txt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: '12345',
    });
    assert.equal(tooLarge.status, 413);

    const accepted = await fetch(`${link.url}/files?name=small.txt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: '1234',
    });
    assert.equal(accepted.status, 201);
    const overCount = await fetch(`${link.url}/files?name=second.txt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: '1',
    });
    assert.equal(overCount.status, 409);
  } finally {
    await harness.dispose();
  }
});

test('mobile file picker keeps the token retryable when bridge event delivery fails', async () => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexbridge-mobile-picker-retry-'));
  let deliveryAttempts = 0;
  const service = new MobileFilePickerService({
    rootDir,
    host: '127.0.0.1',
    port: 0,
    async onUpload() {
      deliveryAttempts += 1;
      if (deliveryAttempts === 1) {
        throw new Error('temporary dispatch failure');
      }
    },
  });
  await service.start();
  try {
    const link = await service.createUploadSession(createWeixinEvent());
    assert.equal((await fetch(`${link.url}/files?name=retry.txt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: 'retry',
    })).status, 201);

    assert.equal((await fetch(`${link.url}/complete`, { method: 'POST' })).status, 503);
    assert.equal((await fetch(`${link.url}/complete`, { method: 'POST' })).status, 202);
    assert.equal(deliveryAttempts, 2);
    assert.equal((await fetch(link.url)).status, 410);
  } finally {
    await service.stop();
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('mobile file picker accepts wx.uploadFile multipart payloads and marks the source as WeChat chat files', async () => {
  const harness = await createTestService();
  try {
    const link = await harness.service.createUploadSession(createWeixinEvent());
    const boundary = '----codexbridge-test';
    const body = Buffer.from([
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="chat-report.txt"\r\nContent-Type: text/plain\r\n\r\n`,
      'hello from wx.uploadFile\r\n',
      `--${boundary}--\r\n`,
    ].join(''), 'utf8');
    const upload = await fetch(`${link.url}/files?name=${encodeURIComponent('聊天报告.txt')}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) },
      body,
    });
    assert.equal(upload.status, 201);
    assert.equal((await fetch(`${link.url}/complete`, { method: 'POST' })).status, 202);
    const event = await harness.receivedEvent;
    assert.equal((event.metadata?.mobileFilePicker as any)?.source, 'wechat_message_file');
    assert.equal(event.attachments?.[0].fileName, '聊天报告.txt');
    assert.deepEqual(await fsp.readFile(event.attachments?.[0].localPath ?? ''), Buffer.from('hello from wx.uploadFile'));
  } finally {
    await harness.dispose();
  }
});

test('mobile file picker can return a configured mini program entry point with the upload session URL', async () => {
  const harness = await createTestService({ miniProgramUrlTemplate: 'https://mini.example/pick?uploadUrl={uploadUrl}' });
  try {
    const link = await harness.service.createUploadSession(createWeixinEvent());
    assert.equal(link.picker, 'wechat_chat_file_picker');
    assert.match(link.url, /^https:\/\/mini\.example\/pick\?uploadUrl=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fmobile-upload%2F[a-f0-9]{64}$/u);
    assert.match(link.fallbackUrl ?? '', /\/mobile-upload\/[a-f0-9]{64}$/u);
  } finally {
    await harness.dispose();
  }
});
