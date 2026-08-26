import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import {
  createPinnedLookup,
  resolvePublicAddress,
  verifyPinnedSocket,
} from '../src/services/importer/import-fetch';
import type { ServerModelSummary } from './model-store';

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export type ServerAIRequest = {
  prompt?: string;
  messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  maxOutputTokens?: number;
};

export type ServerAIChunk = {
  text: string;
  done: boolean;
  model?: string;
};

export type ServerAIModelConfig = {
  model: ServerModelSummary;
  apiKey: string;
};

export interface ServerAIGateway {
  test(modelId: string, config: ServerAIModelConfig): Promise<Record<string, unknown>>;
  stream(
    modelId: string,
    config: ServerAIModelConfig,
    request: ServerAIRequest,
  ): AsyncIterable<ServerAIChunk>;
}

function endpoint(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('AI 服务地址无效');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
    throw new Error('AI 服务地址无效');
  }
  return url;
}

function messages(request: ServerAIRequest): Array<{ role: string; content: string }> {
  if (request.messages && request.messages.length > 0) return request.messages;
  return [{ role: 'user', content: request.prompt ?? '' }];
}

async function openRequest(url: URL, headers: Record<string, string>, body: string): Promise<IncomingMessage> {
  const address = await resolvePublicAddress(url.hostname);
  return await new Promise<IncomingMessage>((resolve, reject) => {
    const client = httpsRequest(
      {
        protocol: 'https:',
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        servername: url.hostname,
        rejectUnauthorized: true,
        agent: false,
        lookup: createPinnedLookup(address),
        headers,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          resolve(response);
          return;
        }
        response.resume();
        reject(new Error(`AI 服务返回 HTTP ${status}`));
      },
    );
    client.setTimeout(REQUEST_TIMEOUT_MS, () => client.destroy(new Error('AI 服务请求超时')));
    client.once('socket', (socket: Socket) => {
      const verify = () => {
        try {
          verifyPinnedSocket(socket, address);
        } catch (error) {
          client.destroy(error as Error);
        }
      };
      socket.once('secureConnect', verify);
      socket.once('connect', verify);
    });
    client.once('error', reject);
    client.end(body);
  });
}

async function* lines(response: IncomingMessage): AsyncGenerator<string> {
  let total = 0;
  let buffered = '';
  for await (const chunk of response) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    total += Buffer.byteLength(text);
    if (total > MAX_RESPONSE_BYTES) throw new Error('AI 服务响应超过大小限制');
    buffered += text;
    const chunks = buffered.split(/\r?\n/);
    buffered = chunks.pop() ?? '';
    for (const line of chunks) yield line;
  }
  if (buffered) yield buffered;
}

function openAIUrl(config: ServerAIModelConfig): URL {
  const base = endpoint(config.model.baseUrl);
  const path = base.pathname.replace(/\/+$/, '') || '/v1';
  base.pathname = `${path === '/' ? '/v1' : path}/chat/completions`;
  base.search = '';
  return base;
}

function geminiUrl(config: ServerAIModelConfig): URL {
  const model = encodeURIComponent(config.model.model.replace(/^models\//, ''));
  return endpoint(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`);
}

function openAIRequest(config: ServerAIModelConfig, request: ServerAIRequest): { url: URL; body: string; headers: Record<string, string> } {
  return {
    url: openAIUrl(config),
    body: JSON.stringify({
      model: config.model.model,
      messages: messages(request),
      stream: true,
      temperature: request.temperature ?? config.model.temperature,
      ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
    }),
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(config.model.customHeaders ?? {}),
    },
  };
}

function geminiRequest(config: ServerAIModelConfig, request: ServerAIRequest): { url: URL; body: string; headers: Record<string, string> } {
  const prompt = messages(request)
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n\n');
  return {
    url: geminiUrl(config),
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: request.temperature ?? config.model.temperature,
        ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
      },
    }),
    headers: {
      'x-goog-api-key': config.apiKey,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(config.model.customHeaders ?? {}),
    },
  };
}

function extractOpenAI(data: Record<string, unknown>): string {
  const choices = data.choices;
  if (!Array.isArray(choices)) return '';
  const delta = choices[0];
  if (!delta || typeof delta !== 'object') return '';
  const content = (delta as { delta?: { content?: unknown } }).delta?.content;
  return typeof content === 'string' ? content : '';
}

function extractGemini(data: Record<string, unknown>): string {
  const candidates = data.candidates;
  if (!Array.isArray(candidates)) return '';
  const parts = (candidates[0] as { content?: { parts?: Array<{ text?: unknown }> } } | undefined)?.content?.parts;
  return Array.isArray(parts)
    ? parts.map((part) => (typeof part.text === 'string' ? part.text : '')).join('')
    : '';
}

export class DefaultServerAIGateway implements ServerAIGateway {
  async test(modelId: string, config: ServerAIModelConfig): Promise<Record<string, unknown>> {
    for await (const _chunk of this.stream(modelId, config, { prompt: 'Reply with OK.', maxOutputTokens: 8 })) {
      if (_chunk.text || _chunk.done) break;
    }
    return { model: modelId, reachable: true };
  }

  async *stream(
    _modelId: string,
    config: ServerAIModelConfig,
    request: ServerAIRequest,
  ): AsyncGenerator<ServerAIChunk> {
    const prepared = config.model.provider === 'gemini' ? geminiRequest(config, request) : openAIRequest(config, request);
    const response = await openRequest(prepared.url, prepared.headers, prepared.body);
    for await (const line of lines(response)) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const data = JSON.parse(raw) as Record<string, unknown>;
        const text = config.model.provider === 'gemini' ? extractGemini(data) : extractOpenAI(data);
        if (text) yield { text, done: false, model: config.model.model };
      } catch {
        throw new Error('AI 服务流响应无效');
      }
    }
    yield { text: '', done: true, model: config.model.model };
  }
}
