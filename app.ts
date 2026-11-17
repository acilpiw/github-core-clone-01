// app.ts — the forge's HTTP server: one in-memory store, four surfaces (git smart HTTP,
// REST v3, GraphQL v4 and MCP), plus the health probe the env calls at boot. Everything is
// buffered and dispatched synchronously per request; a handler that throws answers 500 and
// the server keeps serving.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './lib/git-http.ts';
import { handleGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';
import { handleRest } from './lib/rest.ts';
import { ForgeStore } from './lib/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The largest request body accepted (packs and file contents here are kilobytes). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The bearer token every API call must present (set by the environment). */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** The path of a request, or '/' when it does not parse. */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The query string of a request, empty when it does not parse. */
function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** The origin a client reached us at, for absolute Link URLs (same host as the request). */
function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'entry';
  return `http://${host}`;
}

/** True when the request carries the shop token as a Bearer token. */
function authorized(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return false;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${SHOP_TOKEN}`;
}

/** Write a response with its headers, a content length and the request id. */
function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  extraHeaders: Readonly<Record<string, string>>,
  requestId: string,
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
    ...extraHeaders,
  });
  res.end(body);
}

function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  requestId: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(value)}\n`;
  send(res, status, JSON_TYPE, Buffer.from(text, 'utf8'), extraHeaders, requestId);
}

/** Buffer a request body, rejecting it when it grows past the cap. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Build the server. It binds nothing until the caller listens on an ephemeral port. */
export function createApp(): Server {
  const store = new ForgeStore();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = store.nextRequestId();
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const path = pathOf(req);
        const query = queryOf(req);
        const origin = originOf(req);

        // The env's boot probe: 200 {"ok":true}, no token needed.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true }, requestId);
          return;
        }

        // Everything else presents a Bearer token.
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials' }, requestId);
          return;
        }

        const body = await readBody(req);
        const cleanPath = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;

        // Git smart HTTP: /{owner}/{repo}.git/info/refs and the two pack endpoints.
        const git = GIT_ROUTE.exec(cleanPath);
        if (git !== null) {
          const [, owner, repoName, endpoint] = git as unknown as [string, string, string, string];
          if (endpoint === 'info/refs') {
            const service = query.get('service') ?? '';
            const result = handleInfoRefs(store, owner, repoName, service, req.headers['git-protocol'] ?? null);
            send(res, result.status, result.contentType, result.body, {}, requestId);
            return;
          }
          if (endpoint === 'git-upload-pack') {
            const result = handleUploadPack(store, owner, repoName, body, req.headers['git-protocol'] ?? null);
            send(res, result.status, result.contentType, result.body, {}, requestId);
            return;
          }
          const result = handleReceivePack(store, owner, repoName, body);
          send(res, result.status, result.contentType, result.body, {}, requestId);
          return;
        }

        // REST v3: the API root, the user endpoints and the repository resources.
        if (cleanPath === '/api/v3' || cleanPath.startsWith('/api/v3/') || cleanPath.startsWith('/user/') || cleanPath.startsWith('/repos/')) {
          const headers = new Map<string, string>();
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') headers.set(key.toLowerCase(), value);
          }
          const result = handleRest(store, { method, pathname: cleanPath, query, headers, body }, origin);
          send(res, result.status, result.headers['content-type'] ?? JSON_TYPE, result.body, result.headers, requestId);
          return;
        }

        // GraphQL v4: POST /api/graphql, one operation or a JSON array of them.
        if (cleanPath === '/api/graphql' && method === 'POST') {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(body.toString('utf8')) as unknown;
          } catch {
            parsed = null;
          }
          const result = handleGraphQL(store, parsed);
          send(res, result.status, 'application/json; charset=utf-8', result.body, {}, requestId);
          return;
        }

        // Model Context Protocol: POST /mcp, one JSON-RPC request per body.
        if (cleanPath === '/mcp' && method === 'POST') {
          const result = handleMcp(store, origin, body);
          send(res, result.status, result.contentType, result.body, {}, requestId);
          return;
        }

        // Everything else: a JSON 404.
        sendJson(res, 404, { message: 'Not Found' }, requestId);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' }, requestId);
        } else {
          res.end();
        }
      }
    })();
  });
}
