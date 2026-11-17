// lib/mcp.ts — the Model Context Protocol endpoint (Streamable HTTP, 2026-07-28 revision):
// server/discover, initialize, tools/list and tools/call over one POST /mcp, answered with a
// single JSON body. The tools are the six github-mcp-server names, and they read and write the
// same store REST does, so an object made over MCP is the same object over REST.

import {
  ForgeStore,
  VIEWER_ID,
  VIEWER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

/** The revision this server speaks. */
export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const MCP_SERVER_NAME = 'forge';
export const MCP_SERVER_VERSION = '1.0.0';

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The six tools, in a fixed order (tools/list must be byte-identical across calls). */
const TOOLS: readonly McpToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from one branch into another.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch.' },
        base: { type: 'string', description: 'The base branch.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

const REQUIRED_ARGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
});

function repoShape(repo: Repo, baseUrl: string): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}`,
    url: `${baseUrl}/repos/${repo.owner}/${repo.name}`,
  };
}

function issueShape(repo: Repo, issue: Issue, baseUrl: string): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? '000000' })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    url: `${baseUrl}/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `${baseUrl}/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullShape(repo: Repo, pull: Pull, baseUrl: string): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    url: `${baseUrl}/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${baseUrl}/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

interface ToolOutcome {
  /** The tool result object (content + structuredContent + isError). */
  result: Record<string, unknown>;
}

function toolOk(value: Record<string, unknown> | unknown[]): ToolOutcome {
  const text = JSON.stringify(value);
  return { result: { content: [{ type: 'text', text }], structuredContent: value, isError: false } };
}

function toolError(message: string): ToolOutcome {
  return { result: { content: [{ type: 'text', text: message }], isError: true } };
}

/** The missing required arguments of a call, in schema order. */
function missingArgs(tool: string, args: Record<string, unknown>): string[] {
  const required = REQUIRED_ARGS[tool] ?? [];
  return required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

/** Resolve a repository from tool arguments; null when the owner is not the viewer or it is missing. */
function resolveRepo(store: ForgeStore, args: Record<string, unknown>): Repo | null {
  const owner = args.owner;
  const repo = args.repo;
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, repo) ?? null;
}

/** Run one tool call. The result is a tool result object (never a JSON-RPC error). */
function callTool(store: ForgeStore, baseUrl: string, name: string, args: Record<string, unknown>): ToolOutcome {
  const missing = missingArgs(name, args);
  if (missing.length > 0) {
    return toolError(`missing required argument(s): ${missing.join(', ')}`);
  }
  switch (name) {
    case 'create_repo': {
      const repoName = args.name as string;
      const repo = store.createRepo(VIEWER_LOGIN, repoName, {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      if (repo === null) return toolError(`a repository named ${repoName} already exists`);
      return toolOk(repoShape(repo, baseUrl));
    }
    case 'get_repo': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError(`repository ${String(args.owner)}/${String(args.repo)} was not found`);
      return toolOk(repoShape(repo, baseUrl));
    }
    case 'create_issue': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError(`repository ${String(args.owner)}/${String(args.repo)} was not found`);
      repo.issueSeq += 1;
      const createdAt = store.nextIso();
      const issue: Issue = {
        number: repo.issueSeq,
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        createdAt,
        updatedAt: createdAt,
        createdSeq: repo.issueSeq,
      };
      repo.issues.push(issue);
      return toolOk(issueShape(repo, issue, baseUrl));
    }
    case 'list_issues': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError(`repository ${String(args.owner)}/${String(args.repo)} was not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues
        .filter((issue) => (state === 'all' ? true : issue.state === state))
        .map((issue) => issueShape(repo, issue, baseUrl));
      return toolOk({ issues: list });
    }
    case 'create_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError(`repository ${String(args.owner)}/${String(args.repo)} was not found`);
      const head = args.head as string;
      const base = args.base as string;
      const headSha = store.resolveRef(repo, head);
      const baseSha = store.resolveRef(repo, base);
      if (headSha === undefined || baseSha === undefined) return toolError('head and base must be existing branches');
      repo.pullSeq += 1;
      const pull: Pull = {
        number: repo.pullSeq,
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        mergeBaseSha: baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: store.nextIso(),
        createdSeq: repo.pullSeq,
      };
      repo.pulls.push(pull);
      return toolOk(pullShape(repo, pull, baseUrl));
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError(`repository ${String(args.owner)}/${String(args.repo)} was not found`);
      const number = args.pull_number;
      if (typeof number !== 'number' || !Number.isInteger(number)) return toolError('pull_number must be an integer');
      const pull = repo.pulls.find((item) => item.number === number);
      if (pull === undefined) return toolError(`pull request #${number} was not found`);
      const merged = store.mergePullRequest(repo, pull);
      if (!merged.ok) return toolError(merged.message);
      return toolOk({ merged: true, number: pull.number, state: pull.state, sha: merged.sha });
    }
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC framing.
// ---------------------------------------------------------------------------

export interface McpHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function rpcResult(id: unknown, result: unknown): McpHttpResult {
  return {
    status: 200,
    contentType: 'application/json',
    body: Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`, 'utf8'),
  };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpHttpResult {
  return {
    status,
    contentType: 'application/json',
    body: Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`, 'utf8'),
  };
}

/**
 * Handle one POST /mcp body. A body that is not JSON is an HTTP 400 with JSON-RPC -32700.
 * A notification (no id) is answered with an empty 202. Every request's id is echoed exactly.
 */
export function handleMcp(store: ForgeStore, baseUrl: string, body: Buffer): McpHttpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const record = parsed as Record<string, unknown>;
  const method = record.method;
  const id = record.id ?? null;
  const hasId = record.id !== undefined && record.id !== null;
  const params = (record.params ?? {}) as Record<string, unknown>;

  if (typeof method !== 'string') {
    return rpcError(id, -32600, 'Invalid Request');
  }

  // A notification carries no id and gets no JSON-RPC response.
  if (!hasId) {
    if (method === 'notifications/initialized') {
      return { status: 202, contentType: 'application/json', body: Buffer.alloc(0) };
    }
    return { status: 202, contentType: 'application/json', body: Buffer.alloc(0) };
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      resultType: 'discover',
      supportedVersions: [MCP_PROTOCOL_VERSION],
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = params.name;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string' || name === '') {
      return rpcError(id, -32602, 'tools/call needs a tool name');
    }
    if (!TOOLS.some((tool) => tool.name === name)) {
      return rpcError(id, -32602, `unknown tool: ${name}`);
    }
    const outcome = callTool(store, baseUrl, name, args);
    return rpcResult(id, outcome.result);
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}
