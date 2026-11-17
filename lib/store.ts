// lib/store.ts — the forge's in-memory state: repositories, git objects and refs, issues,
// labels, comments and pull requests. Everything lives in Maps; nothing touches the disk.
// Deterministic: ids and timestamps come from counters seeded at fixed values, never from
// Date.now() or Math.random(), so two runs over the same requests hold the same state.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTree,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';

/** The login the bearer token names (the scenario's viewer, fixed by its constant seed). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** The default branch every repository is born with. */
export const DEFAULT_BRANCH = 'main';

/** The first timestamp the deterministic clock hands out (unix seconds). */
export const CLOCK_EPOCH_SEC = 1700000000;

/** The empty tree's id (git's well-known constant). */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  createdSeq: number;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  /** The base tip when the pull request was opened (the merge-base for conflict checks). */
  mergeBaseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  issueSeq: number;
  comments: Map<number, Comment[]>;
  commentSeq: number;
  pulls: Pull[];
  pullSeq: number;
}

/** One changed file between two trees, with line counts for the pull-request files view. */
export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

/** Count the lines of a buffer (a trailing newline does not start a new line). */
function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/**
 * A tiny LCS line diff: returns [added, removed] line counts between two texts.
 * Files here are small (the suite's blobs are tens of bytes to a few KiB), so the O(n*m)
 * table is cheap.
 */
function diffLines(before: Buffer, after: Buffer): [number, number] {
  const a = before.toString('utf8').split('\n');
  const b = after.toString('utf8').split('\n');
  if (a[a.length - 1] === '') a.pop();
  if (b[b.length - 1] === '') b.pop();
  const n = a.length;
  const m = b.length;
  // One-row DP for the LCS length.
  const dp = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    let prev = 0;
    for (let j = 1; j <= m; j += 1) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  const common = dp[m];
  return [m - common, n - common];
}

/** The forge: every repository, plus the deterministic counters. */
export class ForgeStore {
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private repoCreatedSeq = 0;
  private clockSec = CLOCK_EPOCH_SEC;
  private requestSeq = 0;

  /** The next deterministic timestamp (unix seconds), one second per call. */
  nextTimestamp(): number {
    this.clockSec += 1;
    return this.clockSec;
  }

  /** An ISO-8601 string from the deterministic clock. */
  nextIso(): string {
    return isoOf(this.nextTimestamp());
  }

  /** A non-empty request id for the X-GitHub-Request-Id header. */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  /** Create a repository; null when that owner already has one by that name. */
  createRepo(owner: string, name: string, options: { private?: boolean; description?: string } = {}): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    this.repoSeq += 1;
    this.repoCreatedSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      name,
      owner,
      private: options.private ?? false,
      description: options.description ?? '',
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.repoCreatedSeq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      issueSeq: 0,
      comments: new Map(),
      commentSeq: 0,
      pulls: [],
      pullSeq: 0,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** Every repository of one owner, in creation order. */
  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  // ------------------------------------------------------------ git objects

  /** Store an object, returning its id (idempotent: an existing id is not overwritten). */
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** The object id a ref points at, or undefined when the ref does not exist. */
  refOf(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** The tip of the default branch, or undefined for an unborn repository. */
  defaultTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  /** Resolve a branch name or a full ref to a tip, or undefined. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    return repo.refs.get(`refs/heads/${ref}`);
  }

  /** Every ref, sorted by name (the order advertisements and ls-refs use). */
  sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
    return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // ------------------------------------------------------------ trees

  /** The entries of a tree object (an empty tree when the id is the empty-tree constant). */
  treeEntries(repo: Repo, treeOid: string): TreeEntry[] {
    if (treeOid === EMPTY_TREE_OID) return [];
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') throw new Error(`tree ${treeOid} is missing`);
    return parseTree(object.data);
  }

  /** The flat path -> {oid, mode} map of a tree, recursing into directories. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, base: string): void => {
      for (const entry of this.treeEntries(repo, oid)) {
        const path = base === '' ? entry.name : `${base}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /**
   * A new tree with `path` set to `blobOid` (creating intermediate directories), stored in the
   * repo. `treeOid` is the current root tree, or null for an empty tree.
   */
  setFileInTree(repo: Repo, treeOid: string | null, path: string, blobOid: string): string {
    const segments = path.split('/').filter((part) => part !== '');
    if (segments.length === 0) throw new Error('cannot set an empty path');
    const build = (oid: string | null, depth: number): string => {
      const entries = oid === null ? [] : this.treeEntries(repo, oid);
      const name = segments[depth];
      const isLeaf = depth === segments.length - 1;
      const next: TreeEntry[] = [];
      let replaced = false;
      for (const entry of entries) {
        if (entry.name !== name) {
          next.push(entry);
          continue;
        }
        replaced = true;
        if (isLeaf) next.push({ mode: '100644', name, oid: blobOid });
        else if (entry.mode === '40000') next.push({ mode: '40000', name, oid: build(entry.oid, depth + 1) });
        else next.push({ mode: '40000', name, oid: build(null, depth + 1) });
      }
      if (!replaced) {
        if (isLeaf) next.push({ mode: '100644', name, oid: blobOid });
        else next.push({ mode: '40000', name, oid: build(null, depth + 1) });
      }
      return this.putObject(repo, 'tree', buildTree(next));
    };
    return build(treeOid, 0);
  }

  /**
   * A new tree with `path` removed, stored in the repo; null when the root tree becomes empty.
   * Empty intermediate directories are pruned.
   */
  removeFileFromTree(repo: Repo, treeOid: string, path: string): string | null {
    const segments = path.split('/').filter((part) => part !== '');
    if (segments.length === 0) return treeOid;
    const build = (oid: string, depth: number): string | null => {
      const name = segments[depth];
      const isLeaf = depth === segments.length - 1;
      const next: TreeEntry[] = [];
      for (const entry of this.treeEntries(repo, oid)) {
        if (entry.name !== name) {
          next.push(entry);
          continue;
        }
        if (isLeaf) continue; // drop the file
        if (entry.mode !== '40000') continue;
        const child = build(entry.oid, depth + 1);
        if (child !== null) next.push({ mode: '40000', name, oid: child });
      }
      if (next.length === 0) return null;
      return this.putObject(repo, 'tree', buildTree(next));
    };
    return build(treeOid, 0);
  }

  /** The tree object id of a directory inside a tree, or null when it is not a directory. */
  treeAtPath(repo: Repo, treeOid: string, path: string): string | null {
    const segments = path.split('/').filter((part) => part !== '');
    let current = treeOid;
    for (const segment of segments) {
      const entry = this.treeEntries(repo, current).find((item) => item.name === segment);
      if (entry === undefined || entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return current;
  }

  /** Read one file's blob at a tree; null when the path is not a file there. */
  fileAtTree(repo: Repo, treeOid: string, path: string): { oid: string; data: Buffer } | null {
    const flat = this.flattenTree(repo, treeOid);
    const found = flat.get(path);
    if (!found || found.mode === '40000') return null;
    const object = repo.objects.get(found.oid);
    if (!object || object.type !== 'blob') return null;
    return { oid: found.oid, data: object.data };
  }

  // ------------------------------------------------------------ commits

  /**
   * Commit one file change on a branch: replace (or add) `path` with `content`, build the
   * commit and move the branch. Works on an unborn branch (no parents). Returns the commit
   * and blob ids.
   */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; blobSha: string } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    const baseTree = tip === undefined ? null : parseCommit(repo.objects.get(tip)!.data).tree;
    const blobSha = this.putObject(repo, 'blob', content);
    const treeSha = this.setFileInTree(repo, baseTree, path, blobSha);
    const timestamp = this.nextTimestamp();
    const who = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const commit = buildCommit({
      tree: treeSha,
      parents: tip === undefined ? [] : [tip],
      message,
      author: who,
      committer: who,
      timestamp,
    });
    const commitSha = this.putObject(repo, 'commit', commit);
    repo.refs.set(ref, commitSha);
    return { commitSha, blobSha };
  }

  /**
   * Delete one file on a branch and commit the removal. Returns the commit id, or null when
   * the file is not on the branch.
   */
  deleteFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string } | null {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) return null;
    const baseTree = parseCommit(repo.objects.get(tip)!.data).tree;
    if (this.fileAtTree(repo, baseTree, path) === null) return null;
    const treeSha = this.removeFileFromTree(repo, baseTree, path) ?? EMPTY_TREE_OID;
    const timestamp = this.nextTimestamp();
    const who = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const commit = buildCommit({
      tree: treeSha,
      parents: [tip],
      message,
      author: who,
      committer: who,
      timestamp,
    });
    const commitSha = this.putObject(repo, 'commit', commit);
    repo.refs.set(ref, commitSha);
    return { commitSha };
  }

  /** Commit ids reachable from a tip, newest first, following first parents only. */
  listCommits(repo: Repo, tip: string | undefined): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    let current = tip;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const object = repo.objects.get(current);
      if (!object || object.type !== 'commit') break;
      out.push(current);
      current = parseCommit(object.data).parents[0];
    }
    return out;
  }

  /** The changed files between two trees, with line counts (for pull-request files). */
  diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): FileChange[] {
    const base = this.flattenTree(repo, baseTreeOid);
    const head = this.flattenTree(repo, headTreeOid);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const changes: FileChange[] = [];
    for (const path of [...paths].sort()) {
      const before = base.get(path);
      const after = head.get(path);
      if (before !== undefined && after === undefined) {
        const data = repo.objects.get(before.oid)?.data ?? Buffer.alloc(0);
        const deletions = lineCount(data);
        changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (before === undefined && after !== undefined) {
        const data = repo.objects.get(after.oid)?.data ?? Buffer.alloc(0);
        const additions = lineCount(data);
        changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (before !== undefined && after !== undefined && before.oid !== after.oid) {
        const beforeData = repo.objects.get(before.oid)?.data ?? Buffer.alloc(0);
        const afterData = repo.objects.get(after.oid)?.data ?? Buffer.alloc(0);
        const [additions, deletions] = diffLines(beforeData, afterData);
        changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return changes;
  }

  /** The tree a ref points at (via its tip commit), or undefined when the ref is unborn. */
  treeOfRef(repo: Repo, ref: string): string | undefined {
    const tip = this.resolveRef(repo, ref);
    if (tip === undefined) return undefined;
    const object = repo.objects.get(tip);
    if (!object || object.type !== 'commit') return undefined;
    return parseCommit(object.data).tree;
  }

  /**
   * Whether a pull request would conflict: head and base both changed the same file against
   * the merge-base, with different resulting contents. (MERGEABLE/CONFLICTING for GraphQL.)
   */
  pullRequestConflicts(repo: Repo, pull: Pull): boolean {
    const mergeBaseTree = parseCommit(repo.objects.get(pull.mergeBaseSha)!.data).tree;
    const headTree = parseCommit(repo.objects.get(pull.headSha)!.data).tree;
    const currentBaseTip = this.resolveRef(repo, pull.baseRef);
    if (currentBaseTip === undefined) return false;
    const currentBaseTree = parseCommit(repo.objects.get(currentBaseTip)!.data).tree;
    const headChanges = new Map(this.diffTrees(repo, mergeBaseTree, headTree).map((change) => [change.filename, change]));
    const baseChanges = this.diffTrees(repo, mergeBaseTree, currentBaseTree);
    const baseFlat = this.flattenTree(repo, currentBaseTree);
    const headFlat = this.flattenTree(repo, headTree);
    for (const baseChange of baseChanges) {
      if (!headChanges.has(baseChange.filename)) continue;
      const headEntry = headFlat.get(baseChange.filename);
      const baseEntry = baseFlat.get(baseChange.filename);
      if (headEntry === undefined || baseEntry === undefined) continue;
      if (headEntry.oid !== baseEntry.oid) return true;
    }
    return false;
  }

  /**
   * Squash-merge an open pull request onto its base branch: one new commit on the base with
   * the head's tree, then the pull request closes as merged. Shared by REST and GraphQL.
   */
  mergePullRequest(repo: Repo, pull: Pull): { ok: true; sha: string } | { ok: false; status: number; message: string } {
    if (pull.merged) return { ok: false, status: 405, message: 'the pull request is already merged' };
    if (pull.state !== 'open') return { ok: false, status: 405, message: 'the pull request is closed' };
    if (this.pullRequestConflicts(repo, pull)) {
      return { ok: false, status: 405, message: 'merge conflict' };
    }
    const headTree = parseCommit(repo.objects.get(pull.headSha)!.data).tree;
    const currentBaseTip = this.resolveRef(repo, pull.baseRef);
    if (currentBaseTip === undefined) return { ok: false, status: 404, message: 'the base branch does not exist' };
    const timestamp = this.nextTimestamp();
    const who = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const commit = buildCommit({
      tree: headTree,
      parents: [currentBaseTip],
      message: `Merge pull request #${pull.number} from ${pull.headRef}`,
      author: who,
      committer: who,
      timestamp,
    });
    const mergeSha = this.putObject(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date(timestamp * 1000).toISOString();
    pull.mergeCommitSha = mergeSha;
    return { ok: true, sha: mergeSha };
  }

  /** Every object id reachable from a tip (for fetch exclusion math). */
  reachableFrom(repo: Repo, tip: string): Set<string> {
    return collectReachable([tip], this.lookup(repo), { allowMissing: true });
  }

  /** True when the object id exists in this repo. */
  hasObject(repo: Repo, oid: string): boolean {
    return repo.objects.has(oid);
  }

  /** The zero id, for callers that need it without importing git.ts. */
  zeroOid(): string {
    return ZERO_OID;
  }
}
