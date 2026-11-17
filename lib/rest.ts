// lib/rest.ts — the GitHub REST v3 surface: the root/meta/user endpoints, repositories,
// refs, branches, commits, contents, labels, issues, comments and pull requests.
// Hand-written against the endpoint contract; the state lives in lib/store.ts.

import { parseCommit } from './git.ts';
import {
  ForgeStore,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

/** A normalized incoming request (the server buffers the body before dispatch). */
export interface RestRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Map<string, string>;
  body: Buffer;
}

/** What a handler returns: status, extra headers and the body bytes. */
export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function json(status: number, value: unknown, headers: Record<string, string> = {}): RestResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'),
  };
}

function jsonError(status: number, message: string): RestResponse {
  return json(status, { message });
}

function notFound(message = 'Not Found'): RestResponse {
  return jsonError(404, message);
}

function repoShape(store: ForgeStore, repo: Repo, baseUrl: string): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : repo.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}`,
    url: `${baseUrl}/repos/${repo.owner}/${repo.name}`,
    created_at: '2023-11-14T22:13:20Z',
    updated_at: '2023-11-14T22:13:20Z',
  };
}

function issueShape(store: ForgeStore, repo: Repo, issue: Issue, baseUrl: string): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    url: `${baseUrl}/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullShape(store: ForgeStore, repo: Repo, pull: Pull, baseUrl: string): Record<string, unknown> {
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
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
    url: `${baseUrl}/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** Parse a JSON body; null when the body is empty, an error response when it is malformed. */
function parseJsonBody(req: RestRequest): { value: Record<string, unknown> | null; error: RestResponse | null } {
  if (req.body.length === 0) return { value: null, error: null };
  try {
    const parsed: unknown = JSON.parse(req.body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: null, error: jsonError(400, 'request body must be a JSON object') };
    }
    return { value: parsed as Record<string, unknown>, error: null };
  } catch {
    return { value: null, error: jsonError(400, 'malformed JSON') };
  }
}

function pageParams(req: RestRequest): { page: number; perPage: number } {
  const page = Number.parseInt(req.query.get('page') ?? '1', 10);
  const perPage = Number.parseInt(req.query.get('per_page') ?? '30', 10);
  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    perPage: Number.isFinite(perPage) && perPage > 0 ? Math.min(perPage, 100) : 30,
  };
}

/** Slice a list into one page and build the Link header (absolute, same-origin URLs). */
function paginate<T>(req: RestRequest, baseUrl: string, items: T[]): { page: T[]; link: string | null } {
  const { page, perPage } = pageParams(req);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const current = Math.min(page, totalPages);
  const slice = items.slice((current - 1) * perPage, current * perPage);
  const urlFor = (p: number): string => {
    const url = new URL(req.pathname, baseUrl);
    const params = new URLSearchParams(req.query);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    url.search = params.toString();
    return url.toString();
  };
  const links: string[] = [];
  if (current < totalPages) links.push(`<${urlFor(current + 1)}>; rel="next"`);
  if (current > 1) links.push(`<${urlFor(current - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return { page: slice, link: links.length ? links.join(', ') : null };
}

function linkHeaders(link: string | null): Record<string, string> {
  return link === null ? {} : { link };
}

/** Decode a base64 string, or null when it is not valid base64. */
function decodeBase64(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, '');
  if (cleaned.length === 0) return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) return null;
  const decoded = Buffer.from(cleaned, 'base64');
  if (decoded.toString('base64') !== cleaned) return null;
  return decoded;
}

/** Split "name <email> 1700000001 +0000" into its parts. */
function parseIdentity(text: string): { name: string; email: string; date: string } {
  const match = /^(.+?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(text.trim());
  if (!match) return { name: text, email: '', date: '2023-11-14T22:13:20Z' };
  return {
    name: match[1]!,
    email: match[2]!,
    date: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

function commitShape(store: ForgeStore, repo: Repo, sha: string, baseUrl: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const author = parseIdentity(commit.author);
  const committer = parseIdentity(commit.committer);
  return {
    sha,
    commit: {
      message: commit.message,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    url: `${baseUrl}/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

/** Resolve a repo from the path; the owner must be the viewer and the repo must exist. */
function resolveRepo(store: ForgeStore, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

/** The entry point: dispatch a REST request to its handler. */
export function handleRest(store: ForgeStore, req: RestRequest, baseUrl: string): RestResponse {
  const { method } = req;
  // The API lives under /api/v3; strip that prefix so the handlers see GitHub's own paths.
  const pathname = req.pathname.startsWith('/api/v3') ? req.pathname.slice('/api/v3'.length) || '/' : req.pathname;
  const segments = pathname.split('/').filter((part) => part !== '');

  // GET / — the API root, with the OAuth scopes the protocol checks read.
  if (method === 'GET' && pathname === '/') {
    return json(
      200,
      {
        current_user_url: `${baseUrl}/api/v3/user`,
        rate_limit_url: `${baseUrl}/api/v3/rate_limit`,
        repository_url: `${baseUrl}/repos/{owner}/{repo}`,
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (method === 'GET' && pathname === '/meta') {
    return json(200, { installed_version: '1.0.0' });
  }
  if (method === 'GET' && pathname === '/user') {
    return json(200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: 'User',
      html_url: `${baseUrl}/${VIEWER_LOGIN}`,
      url: `${baseUrl}/api/v3/users/${VIEWER_LOGIN}`,
    });
  }

  // POST /user/repos — create a repository under the viewer.
  if (method === 'POST' && pathname === '/user/repos') {
    const { value, error } = parseJsonBody(req);
    if (error) return error;
    const name = typeof value?.name === 'string' ? value.name : '';
    if (name === '' || name.includes('/')) return jsonError(422, 'a repository name is required');
    const repo = store.createRepo(VIEWER_LOGIN, name, {
      private: value?.private === true,
      description: typeof value?.description === 'string' ? value.description : '',
    });
    if (repo === null) return jsonError(422, `a repository named ${name} already exists`);
    return json(201, repoShape(store, repo, baseUrl));
  }

  // GET /user/repos — the viewer's repositories, paginated in creation order.
  if (method === 'GET' && pathname === '/user/repos') {
    const repos = store.listRepos(VIEWER_LOGIN);
    const { page, link } = paginate(req, baseUrl, repos);
    return json(200, page.map((repo) => repoShape(store, repo, baseUrl)), linkHeaders(link));
  }

  // Everything below is /repos/{owner}/{repo}/...
  if (segments[0] !== 'repos' || segments.length < 3) return notFound();
  const [, owner, repoName, ...rest] = segments as [string, string, string, ...string[]];
  const repo = resolveRepo(store, owner, repoName);
  if (repo === null) return notFound();

  // The repository itself: GET, PATCH, DELETE.
  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoShape(store, repo, baseUrl));
    if (method === 'PATCH') {
      const { value, error } = parseJsonBody(req);
      if (error) return error;
      if (typeof value?.description === 'string') repo.description = value.description;
      if (typeof value?.private === 'boolean') repo.private = value.private;
      return json(200, repoShape(store, repo, baseUrl));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204, headers: {}, body: Buffer.alloc(0) };
    }
    return notFound();
  }

  // POST /repos/{o}/{r}/git/refs — create a ref.
  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && method === 'POST') {
    const { value, error } = parseJsonBody(req);
    if (error) return error;
    const ref = typeof value?.ref === 'string' ? value.ref : '';
    const sha = typeof value?.sha === 'string' ? value.sha : '';
    if (!ref.startsWith('refs/') || sha === '') return jsonError(422, 'a ref and a sha are required');
    if (repo.refs.has(ref)) return jsonError(422, `ref ${ref} already exists`);
    if (!repo.objects.has(sha)) return jsonError(422, `object ${sha} does not exist`);
    repo.refs.set(ref, sha);
    return json(201, { ref, object: { sha, type: repo.objects.get(sha)!.type, url: `${baseUrl}/repos/${owner}/${repoName}/git/${repo.objects.get(sha)!.type}s/${sha}` } });
  }

  // GET /repos/{o}/{r}/git/refs/heads/{branch} — one branch ref.
  if (rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && rest.length === 4 && method === 'GET') {
    const ref = `refs/heads/${rest[3]}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) return notFound();
    return json(200, { ref, object: { sha, type: 'commit', url: `${baseUrl}/repos/${owner}/${repoName}/git/commits/${sha}` } });
  }

  // GET /repos/{o}/{r}/branches — every branch; GET /branches/{branch} — one branch.
  if (rest[0] === 'branches' && method === 'GET') {
    const branchShape = (name: string, sha: string): Record<string, unknown> => ({
      name,
      commit: { sha, url: `${baseUrl}/repos/${owner}/${repoName}/commits/${sha}` },
      protected: false,
    });
    if (rest.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, sha]) => branchShape(name.slice('refs/heads/'.length), sha))
        .sort((a, b) => (a.name as string < (b.name as string) ? -1 : 1));
      return json(200, branches);
    }
    if (rest.length === 2) {
      const sha = repo.refs.get(`refs/heads/${rest[1]}`);
      if (sha === undefined) return notFound();
      return json(200, branchShape(rest[1]!, sha));
    }
    return notFound();
  }

  // GET /repos/{o}/{r}/commits[?sha=ref] — newest first, first-parent walk.
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const shaParam = req.query.get('sha');
    let tip: string | undefined;
    if (shaParam === null) {
      tip = store.defaultTip(repo);
    } else if (repo.objects.has(shaParam)) {
      tip = shaParam;
    } else {
      tip = store.resolveRef(repo, shaParam);
    }
    if (tip === undefined) return notFound();
    const commits = store.listCommits(repo, tip);
    const shapes = commits
      .map((sha) => commitShape(store, repo, sha, baseUrl))
      .filter((shape): shape is Record<string, unknown> => shape !== null);
    const { page, link } = paginate(req, baseUrl, shapes);
    return json(200, page, linkHeaders(link));
  }

  // Contents: PUT / GET / DELETE /repos/{o}/{r}/contents/{path...}
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    const branch = req.query.get('ref') ?? req.query.get('branch') ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, branch);
    if (method === 'PUT') {
      const { value, error } = parseJsonBody(req);
      if (error) return error;
      const content = decodeBase64(value?.content);
      if (content === null) return jsonError(422, 'content must be base64');
      const message = typeof value?.message === 'string' ? value.message : `Update ${path}`;
      const bodyBranch = typeof value?.branch === 'string' ? value.branch : branch;
      const givenSha = typeof value?.sha === 'string' ? value.sha : undefined;
      const currentTip = store.resolveRef(repo, bodyBranch);
      const currentTree = currentTip === undefined ? null : parseCommit(repo.objects.get(currentTip)!.data).tree;
      const current = currentTree === null ? null : store.fileAtTree(repo, currentTree, path);
      if (givenSha !== undefined) {
        if (current === null || current.oid !== givenSha) {
          return jsonError(409, 'the file has changed since the sha was read');
        }
      }
      const isNew = current === null;
      const { commitSha, blobSha } = store.commitFile(repo, bodyBranch, path, content, message);
      return json(isNew ? 201 : 200, {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: blobSha,
          size: content.length,
          type: 'file',
          encoding: 'base64',
          content: content.toString('base64'),
          url: `${baseUrl}/repos/${owner}/${repoName}/contents/${path}`,
          html_url: `${baseUrl}/${owner}/${repoName}/blob/${bodyBranch}/${path}`,
        },
        commit: { sha: commitSha, message },
      });
    }
    if (method === 'GET') {
      if (tip === undefined) return notFound();
      const tree = parseCommit(repo.objects.get(tip)!.data).tree;
      if (path === '') {
        // The root listing.
        const entries = store.treeEntries(repo, tree).map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: entry.name,
          sha: entry.oid,
          size: entry.mode === '40000' ? 0 : repo.objects.get(entry.oid)?.data.length ?? 0,
          url: `${baseUrl}/repos/${owner}/${repoName}/contents/${entry.name}`,
          html_url: `${baseUrl}/${owner}/${repoName}/blob/${branch}/${entry.name}`,
        }));
        return json(200, entries);
      }
      const file = store.fileAtTree(repo, tree, path);
      if (file !== null) {
        return json(200, {
          type: 'file',
          encoding: 'base64',
          size: file.data.length,
          name: path.split('/').pop() ?? path,
          path,
          content: file.data.toString('base64'),
          sha: file.oid,
          url: `${baseUrl}/repos/${owner}/${repoName}/contents/${path}`,
          html_url: `${baseUrl}/${owner}/${repoName}/blob/${branch}/${path}`,
        });
      }
      // A directory listing: the direct children of the path, with the directory's own
      // tree id for subdirectories and each file's blob id.
      const dirTree = store.treeAtPath(repo, tree, path);
      if (dirTree === null) return notFound();
      const entries = store
        .treeEntries(repo, dirTree)
        .map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: `${path}/${entry.name}`,
          sha: entry.oid,
          size: entry.mode === '40000' ? 0 : repo.objects.get(entry.oid)?.data.length ?? 0,
          url: `${baseUrl}/repos/${owner}/${repoName}/contents/${path}/${entry.name}`,
          html_url: `${baseUrl}/${owner}/${repoName}/blob/${branch}/${path}/${entry.name}`,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return json(200, entries);
    }
    if (method === 'DELETE') {
      const { value, error } = parseJsonBody(req);
      if (error) return error;
      const givenSha = typeof value?.sha === 'string' ? value.sha : undefined;
      const message = typeof value?.message === 'string' ? value.message : `Delete ${path}`;
      const bodyBranch = typeof value?.branch === 'string' ? value.branch : branch;
      const currentTip = store.resolveRef(repo, bodyBranch);
      if (currentTip === undefined) return notFound();
      const currentTree = parseCommit(repo.objects.get(currentTip)!.data).tree;
      const current = store.fileAtTree(repo, currentTree, path);
      if (current === null) return notFound();
      if (givenSha !== undefined && current.oid !== givenSha) {
        return jsonError(409, 'the file has changed since the sha was read');
      }
      const removed = store.deleteFile(repo, bodyBranch, path, message);
      if (removed === null) return notFound();
      return json(200, { commit: { sha: removed.commitSha, message }, content: null });
    }
    return notFound();
  }

  // POST /repos/{o}/{r}/labels — create a label.
  if (rest[0] === 'labels' && rest.length === 1 && method === 'POST') {
    const { value, error } = parseJsonBody(req);
    if (error) return error;
    const name = typeof value?.name === 'string' ? value.name : '';
    const color = typeof value?.color === 'string' ? value.color : '000000';
    if (name === '') return jsonError(422, 'a label name is required');
    if (repo.labels.has(name)) return jsonError(422, `label ${name} already exists`);
    repo.labels.set(name, { name, color });
    return json(201, { name, color, url: `${baseUrl}/repos/${owner}/${repoName}/labels/${encodeURIComponent(name)}`, default: false });
  }

  // Issues: POST / GET list / GET one / PATCH one / comments.
  if (rest[0] === 'issues') {
    if (rest.length === 1 && method === 'POST') {
      const { value, error } = parseJsonBody(req);
      if (error) return error;
      const title = typeof value?.title === 'string' ? value.title : '';
      if (title === '') return jsonError(422, 'an issue title is required');
      const labelNames: string[] = Array.isArray(value?.labels)
        ? (value.labels as unknown[]).filter((label): label is string => typeof label === 'string')
        : [];
      for (const labelName of labelNames) {
        if (!repo.labels.has(labelName)) return jsonError(422, `label ${labelName} does not exist`);
      }
      repo.issueSeq += 1;
      const createdAt = store.nextIso();
      const issue: Issue = {
        number: repo.issueSeq,
        title,
        body: typeof value?.body === 'string' ? value.body : '',
        state: 'open',
        labels: labelNames,
        createdAt,
        updatedAt: createdAt,
        createdSeq: repo.issueSeq,
      };
      repo.issues.push(issue);
      return json(201, issueShape(store, repo, issue, baseUrl));
    }
    if (rest.length === 1 && method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      let list = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
      list = [...list].sort((a, b) => {
        const keyA = sort === 'created' ? a.createdSeq : a.number;
        const keyB = sort === 'created' ? b.createdSeq : b.number;
        return direction === 'asc' ? keyA - keyB : keyB - keyA;
      });
      const { page, link } = paginate(req, baseUrl, list);
      return json(200, page.map((issue) => issueShape(store, repo, issue, baseUrl)), linkHeaders(link));
    }
    const issueNumber = Number(rest[1]);
    const issue = repo.issues.find((item) => item.number === issueNumber);
    if (rest.length === 2 && Number.isInteger(issueNumber)) {
      if (issue === undefined) return notFound();
      if (method === 'GET') return json(200, issueShape(store, repo, issue, baseUrl));
      if (method === 'PATCH') {
        const { value, error } = parseJsonBody(req);
        if (error) return error;
        if (value?.state === 'open' || value?.state === 'closed') issue.state = value.state;
        if (typeof value?.title === 'string') issue.title = value.title;
        if (typeof value?.body === 'string') issue.body = value.body;
        if (Array.isArray(value?.labels)) {
          const labelNames = (value.labels as unknown[]).filter((label): label is string => typeof label === 'string');
          for (const labelName of labelNames) {
            if (!repo.labels.has(labelName)) return jsonError(422, `label ${labelName} does not exist`);
          }
          issue.labels = labelNames;
        }
        issue.updatedAt = store.nextIso();
        return json(200, issueShape(store, repo, issue, baseUrl));
      }
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'comments' && Number.isInteger(issueNumber)) {
      if (issue === undefined) return notFound();
      if (method === 'POST') {
        const { value, error } = parseJsonBody(req);
        if (error) return error;
        const bodyText = typeof value?.body === 'string' ? value.body : '';
        if (bodyText === '') return jsonError(422, 'a comment body is required');
        repo.commentSeq += 1;
        const comment = { id: repo.commentSeq, body: bodyText, createdAt: store.nextIso() };
        const list = repo.comments.get(issueNumber) ?? [];
        list.push(comment);
        repo.comments.set(issueNumber, list);
        return json(201, {
          id: comment.id,
          body: comment.body,
          user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
          created_at: comment.createdAt,
          updated_at: comment.createdAt,
          url: `${baseUrl}/repos/${owner}/${repoName}/issues/comments/${comment.id}`,
          html_url: `${baseUrl}/${owner}/${repoName}/issues/${issueNumber}#issuecomment-${comment.id}`,
        });
      }
      if (method === 'GET') {
        const list = repo.comments.get(issueNumber) ?? [];
        const { page, link } = paginate(req, baseUrl, list);
        return json(
          200,
          page.map((comment) => ({
            id: comment.id,
            body: comment.body,
            user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
            created_at: comment.createdAt,
            updated_at: comment.createdAt,
            url: `${baseUrl}/repos/${owner}/${repoName}/issues/comments/${comment.id}`,
            html_url: `${baseUrl}/${owner}/${repoName}/issues/${issueNumber}#issuecomment-${comment.id}`,
          })),
          linkHeaders(link),
        );
      }
      return notFound();
    }
    return notFound();
  }

  // Pull requests: POST / GET list / GET one / files / merge.
  if (rest[0] === 'pulls') {
    if (rest.length === 1 && method === 'POST') {
      const { value, error } = parseJsonBody(req);
      if (error) return error;
      const head = typeof value?.head === 'string' ? value.head : '';
      const base = typeof value?.base === 'string' ? value.base : '';
      const title = typeof value?.title === 'string' ? value.title : '';
      if (head === '' || base === '' || title === '') return jsonError(422, 'head, base and title are required');
      const headSha = store.resolveRef(repo, head);
      const baseSha = store.resolveRef(repo, base);
      if (headSha === undefined || baseSha === undefined) return jsonError(422, 'head and base must be existing branches');
      repo.pullSeq += 1;
      const pull: Pull = {
        number: repo.pullSeq,
        title,
        body: typeof value?.body === 'string' ? value.body : '',
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
      return json(201, pullShape(store, repo, pull, baseUrl));
    }
    if (rest.length === 1 && method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const list = repo.pulls
        .filter((pull) => (state === 'all' ? true : pull.state === state))
        .sort((a, b) => b.createdSeq - a.createdSeq);
      const { page, link } = paginate(req, baseUrl, list);
      return json(200, page.map((pull) => pullShape(store, repo, pull, baseUrl)), linkHeaders(link));
    }
    const pullNumber = Number(rest[1]);
    const pull = repo.pulls.find((item) => item.number === pullNumber);
    if (rest.length === 2 && Number.isInteger(pullNumber)) {
      if (pull === undefined) return notFound();
      if (method === 'GET') return json(200, pullShape(store, repo, pull, baseUrl));
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'files' && Number.isInteger(pullNumber) && method === 'GET') {
      if (pull === undefined) return notFound();
      const headCommit = repo.objects.get(pull.headSha);
      const baseCommit = repo.objects.get(pull.baseSha);
      if (!headCommit || !baseCommit) return notFound();
      const headTree = parseCommit(headCommit.data).tree;
      const baseTree = parseCommit(baseCommit.data).tree;
      const files = store.diffTrees(repo, baseTree, headTree);
      return json(200, files.map((file) => ({ ...file, blob_url: `${baseUrl}/${owner}/${repoName}/blob/${pull.headSha}/${file.filename}` })));
    }
    if (rest.length === 3 && rest[2] === 'merge' && Number.isInteger(pullNumber) && method === 'PUT') {
      if (pull === undefined) return notFound();
      if (pull.merged) return jsonError(405, 'the pull request is already merged');
      if (pull.state !== 'open') return jsonError(405, 'the pull request is closed');
      const { value, error } = parseJsonBody(req);
      if (error) return error;
      const methodName = typeof value?.merge_method === 'string' ? value.merge_method : 'squash';
      if (methodName !== 'squash' && methodName !== 'merge' && methodName !== 'rebase') {
        return jsonError(422, `unknown merge method ${methodName}`);
      }
      const merged = store.mergePullRequest(repo, pull);
      if (!merged.ok) return jsonError(merged.status, merged.message);
      return json(200, { merged: true, sha: merged.sha, message: `Pull Request successfully merged` });
    }
    return notFound();
  }

  return notFound();
}
