import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { InboundAttachment, InboundAttachmentKind, InboundTextEvent } from '../../types/platform.js';
import { getMimeFromFilename } from './official/media/mime.js';

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 43183;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const DEFAULT_PROMPT = '请读取并分析我选择的文件。';

interface UploadedFile {
  localPath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

interface UploadSession {
  token: string;
  event: InboundTextEvent;
  prompt: string;
  directory: string;
  expiresAt: number;
  files: UploadedFile[];
  activeUploads: number;
  completed: boolean;
}

export interface MobileFilePickerBinding {
  host: string;
  port: number;
  baseUrl: string;
}

export interface MobileFilePickerSessionLink {
  url: string;
  expiresAt: number;
}

export interface MobileFilePickerServiceOptions {
  rootDir: string;
  onUpload: (event: InboundTextEvent) => Promise<void> | void;
  onError?: (error: unknown) => Promise<void> | void;
  host?: string;
  port?: number;
  publicBaseUrl?: string | null;
  ttlMs?: number;
  maxFileBytes?: number;
  maxFiles?: number;
  now?: () => number;
}

export class MobileFilePickerService {
  private readonly rootDir: string;
  private readonly onUpload: MobileFilePickerServiceOptions['onUpload'];
  private readonly onError: NonNullable<MobileFilePickerServiceOptions['onError']>;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly configuredPublicBaseUrl: string | null;
  private readonly ttlMs: number;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, UploadSession>();
  private server: Server | null = null;
  private binding: MobileFilePickerBinding | null = null;

  constructor({
    rootDir,
    onUpload,
    onError = async () => {},
    host = DEFAULT_HOST,
    port = DEFAULT_PORT,
    publicBaseUrl = null,
    ttlMs = DEFAULT_TTL_MS,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    maxFiles = DEFAULT_MAX_FILES,
    now = Date.now,
  }: MobileFilePickerServiceOptions) {
    this.rootDir = path.resolve(rootDir);
    this.onUpload = onUpload;
    this.onError = onError;
    this.host = host.trim() || DEFAULT_HOST;
    this.requestedPort = normalizeNonNegativeInteger(port, DEFAULT_PORT);
    this.configuredPublicBaseUrl = normalizeBaseUrl(publicBaseUrl);
    this.ttlMs = normalizePositiveInteger(ttlMs, DEFAULT_TTL_MS);
    this.maxFileBytes = normalizePositiveInteger(maxFileBytes, DEFAULT_MAX_FILE_BYTES);
    this.maxFiles = normalizePositiveInteger(maxFiles, DEFAULT_MAX_FILES);
    this.now = now;
  }

  async start(): Promise<MobileFilePickerBinding> {
    if (this.binding) {
      return this.binding;
    }
    await fsp.mkdir(this.rootDir, { recursive: true });
    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response).catch(async (error) => {
        await this.onError(error);
        if (!response.headersSent) {
          sendJson(response, 500, { ok: false, error: '上传服务处理失败。' });
        } else if (!response.writableEnded) {
          response.end();
        }
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.requestedPort, this.host);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Mobile file picker did not expose a TCP address.');
    }
    const port = address.port;
    const baseUrl = this.configuredPublicBaseUrl ?? `http://${resolveAdvertisedHost(this.host)}:${port}`;
    this.binding = { host: this.host, port, baseUrl };
    return this.binding;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.binding = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  describeBinding(): MobileFilePickerBinding | null {
    return this.binding ? { ...this.binding } : null;
  }

  createUploadSession(event: InboundTextEvent, prompt: string | null = null): MobileFilePickerSessionLink {
    if (!this.binding) {
      throw new Error('Mobile file picker service is not started.');
    }
    this.cleanupExpiredSessions();
    const token = crypto.randomBytes(32).toString('hex');
    const scopeHash = crypto.createHash('sha256').update(String(event.externalScopeId)).digest('hex').slice(0, 16);
    const directory = path.join(this.rootDir, scopeHash, token);
    const expiresAt = this.now() + this.ttlMs;
    this.sessions.set(token, {
      token,
      event: cloneInboundEvent(event),
      prompt: normalizePrompt(prompt),
      directory,
      expiresAt,
      files: [],
      activeUploads: 0,
      completed: false,
    });
    return {
      url: `${this.binding.baseUrl}/mobile-upload/${token}`,
      expiresAt,
    };
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setSecurityHeaders(response);
    const url = new URL(request.url ?? '/', 'http://codexbridge.local');
    const match = /^\/mobile-upload\/([a-f0-9]{64})(?:\/(files|complete))?$/u.exec(url.pathname);
    if (!match) {
      sendJson(response, 404, { ok: false, error: '链接不存在。' });
      return;
    }
    const token = match[1];
    const action = match[2] ?? 'page';
    const session = this.getActiveSession(token);
    if (!session) {
      sendHtml(response, 410, renderExpiredPage());
      return;
    }
    if (request.method === 'GET' && action === 'page') {
      sendHtml(response, 200, renderUploadPage({
        token,
        maxFiles: this.maxFiles,
        maxFileBytes: this.maxFileBytes,
      }));
      return;
    }
    if (request.method === 'PUT' && action === 'files') {
      await this.receiveFile(request, response, url, session);
      return;
    }
    if (request.method === 'POST' && action === 'complete') {
      await this.completeSession(response, session);
      return;
    }
    response.setHeader('Allow', action === 'page' ? 'GET' : action === 'files' ? 'PUT' : 'POST');
    sendJson(response, 405, { ok: false, error: '请求方法不受支持。' });
  }

  private getActiveSession(token: string): UploadSession | null {
    const session = this.sessions.get(token) ?? null;
    if (!session || session.completed) {
      return null;
    }
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(token);
      void fsp.rm(session.directory, { recursive: true, force: true }).catch(() => {});
      return null;
    }
    return session;
  }

  private async receiveFile(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    session: UploadSession,
  ): Promise<void> {
    if (session.files.length + session.activeUploads >= this.maxFiles) {
      sendJson(response, 409, { ok: false, error: `每次最多选择 ${this.maxFiles} 个文件。` });
      return;
    }
    const declaredLength = Number.parseInt(String(request.headers['content-length'] ?? ''), 10);
    if (Number.isFinite(declaredLength) && declaredLength > this.maxFileBytes) {
      sendJson(response, 413, { ok: false, error: '文件超过大小限制。' });
      return;
    }
    const originalName = normalizeUploadedFileName(url.searchParams.get('name'));
    const mimeType = normalizeMimeType(request.headers['content-type'], originalName);
    await fsp.mkdir(session.directory, { recursive: true });
    const storedName = await resolveAvailableFileName(session.directory, originalName);
    const localPath = path.join(session.directory, storedName);
    const limiter = new ByteLimitTransform(this.maxFileBytes);
    session.activeUploads += 1;
    try {
      await pipeline(request, limiter, fs.createWriteStream(localPath, { flags: 'wx' }));
      const sizeBytes = limiter.bytesRead;
      session.files.push({ localPath, fileName: originalName, mimeType, sizeBytes });
      sendJson(response, 201, { ok: true, fileName: originalName, sizeBytes });
    } catch (error) {
      await fsp.rm(localPath, { force: true }).catch(() => {});
      if (error instanceof UploadTooLargeError) {
        sendJson(response, 413, { ok: false, error: '文件超过大小限制。' });
        return;
      }
      throw error;
    } finally {
      session.activeUploads -= 1;
    }
  }

  private async completeSession(response: ServerResponse, session: UploadSession): Promise<void> {
    if (session.activeUploads > 0) {
      sendJson(response, 409, { ok: false, error: '文件仍在上传，请稍候。' });
      return;
    }
    if (session.files.length === 0) {
      sendJson(response, 400, { ok: false, error: '请先选择文件。' });
      return;
    }
    session.completed = true;
    this.sessions.delete(session.token);
    const event: InboundTextEvent = {
      ...cloneInboundEvent(session.event),
      text: session.prompt,
      attachments: session.files.map(toInboundAttachment),
      metadata: {
        ...(session.event.metadata ?? {}),
        mobileFilePicker: {
          source: 'android_saf',
          uploadedAt: this.now(),
          fileCount: session.files.length,
        },
      },
    };
    sendJson(response, 202, { ok: true, fileCount: session.files.length });
    Promise.resolve(this.onUpload(event)).catch(async (error) => {
      await this.onError(error);
    });
  }

  private cleanupExpiredSessions(): void {
    const now = this.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt > now) {
        continue;
      }
      this.sessions.delete(token);
      void fsp.rm(session.directory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

class UploadTooLargeError extends Error {}

class ByteLimitTransform extends Transform {
  bytesRead = 0;

  constructor(private readonly limit: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    this.bytesRead += chunk.length;
    if (this.bytesRead > this.limit) {
      callback(new UploadTooLargeError());
      return;
    }
    callback(null, chunk);
  }
}

function cloneInboundEvent(event: InboundTextEvent): InboundTextEvent {
  return {
    ...event,
    attachments: event.attachments?.map((attachment) => ({ ...attachment })),
    metadata: event.metadata ? { ...event.metadata } : undefined,
  };
}

function toInboundAttachment(file: UploadedFile): InboundAttachment {
  return {
    kind: inferAttachmentKind(file.mimeType),
    localPath: file.localPath,
    fileName: file.fileName,
    mimeType: file.mimeType,
  };
}

function inferAttachmentKind(mimeType: string): InboundAttachmentKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'voice';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

function normalizeUploadedFileName(value: string | null): string {
  const decoded = String(value ?? '').trim();
  const baseName = path.basename(decoded.replaceAll('\\', '/')).trim();
  const safe = baseName
    .replace(/[\u0000-\u001f<>:"/\\|?*]/gu, '_')
    .replace(/[. ]+$/u, '')
    .slice(0, 180);
  return safe && safe !== '.' && safe !== '..' ? safe : 'upload.bin';
}

async function resolveAvailableFileName(directory: string, requestedName: string): Promise<string> {
  const extension = path.extname(requestedName);
  const stem = path.basename(requestedName, extension);
  for (let index = 0; index < 1000; index += 1) {
    const candidate = index === 0 ? requestedName : `${stem}-${index}${extension}`;
    try {
      await fsp.access(path.join(directory, candidate));
    } catch {
      return candidate;
    }
  }
  return `${stem}-${crypto.randomUUID()}${extension}`;
}

function normalizeMimeType(value: string | string[] | undefined, fileName: string): string {
  const header = Array.isArray(value) ? value[0] : value;
  const normalized = String(header ?? '').split(';')[0].trim().toLowerCase();
  return normalized || getMimeFromFilename(fileName);
}

function normalizePrompt(value: string | null): string {
  return String(value ?? '').trim() || DEFAULT_PROMPT;
}

function normalizeBaseUrl(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').trim().replace(/\/+$/u, '');
  if (!normalized) return null;
  const parsed = new URL(normalized);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Mobile file picker public URL must use HTTP or HTTPS.');
  }
  return normalized;
}

function resolveAdvertisedHost(bindHost: string): string {
  if (!['0.0.0.0', '::', '::0'].includes(bindHost)) {
    return bindHost.includes(':') ? `[${bindHost}]` : bindHost;
  }
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        return address.address;
      }
    }
  }
  return '127.0.0.1';
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
}

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(body);
}

function renderExpiredPage(): string {
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>链接已失效</title><body><h1>链接已失效</h1><p>请回到微信重新发送 /pickfile。</p></body></html>';
}

function renderUploadPage({ token, maxFiles, maxFileBytes }: { token: string; maxFiles: number; maxFileBytes: number }): string {
  const maxMiB = Math.floor(maxFileBytes / 1024 / 1024);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>选择微信文件</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:#f5f6f7;color:#171717}main{max-width:560px;margin:0 auto;padding:28px 20px}h1{font-size:24px;margin:0 0 10px}p{line-height:1.6;color:#555}.picker{display:block;margin:22px 0;padding:20px;background:#fff;border:1px solid #ddd;border-radius:8px}input{width:100%;font-size:16px}button{width:100%;min-height:48px;border:0;border-radius:6px;background:#07c160;color:#fff;font-size:17px;font-weight:600}button:disabled{background:#a9dcbc}#status{min-height:26px;margin-top:16px;color:#333}.ok{color:#07883f}.error{color:#c62828}
</style>
</head>
<body><main>
<h1>选择要交给 Codex 的文件</h1>
<p>在系统文件选择器中打开“微信聊天文档”，选择文件后上传。最多 ${maxFiles} 个，单个不超过 ${maxMiB} MiB。</p>
<label class="picker"><input id="files" type="file" multiple></label>
<button id="upload" type="button">上传并发送给 Codex</button>
<div id="status" role="status"></div>
</main>
<script>
const token=${JSON.stringify(token)};const input=document.getElementById('files');const button=document.getElementById('upload');const status=document.getElementById('status');
button.addEventListener('click',async()=>{const files=[...input.files];if(!files.length){show('请先选择文件。','error');return}if(files.length>${maxFiles}){show('每次最多选择 ${maxFiles} 个文件。','error');return}button.disabled=true;try{for(let i=0;i<files.length;i++){const file=files[i];show('正在上传 '+(i+1)+'/'+files.length+'：'+file.name);const result=await fetch('./'+token+'/files?name='+encodeURIComponent(file.name),{method:'PUT',headers:{'Content-Type':file.type||'application/octet-stream'},body:file});const body=await result.json();if(!result.ok)throw new Error(body.error||'上传失败')}const completed=await fetch('./'+token+'/complete',{method:'POST'});const body=await completed.json();if(!completed.ok)throw new Error(body.error||'提交失败');show('已发送给 Codex，可以返回微信查看处理进度。','ok');input.disabled=true}catch(error){show(error.message||String(error),'error');button.disabled=false}});
function show(text,kind=''){status.textContent=text;status.className=kind}
</script></body></html>`;
}
