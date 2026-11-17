// lib/graphql.ts — the GitHub GraphQL v4 surface: a small hand-written document parser and
// executor for the shapes gh and github-mcp-server send (viewer, repository, issue and
// pull-request reads, the __type feature probes, node(id:), the five mutations, batching).
// No GraphQL library; the schema is the table below, and the state is the same store REST uses.

import { parseCommit } from './git.ts';
import {
  ForgeStore,
  VIEWER_ID,
  VIEWER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// Global ids: opaque, stable, round-tripping. base64url over "Kind:<parts>".
// ---------------------------------------------------------------------------

function encodeId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

function decodeId(id: string): { kind: string; parts: string[] } | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '' || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return encodeId('Repository', repo.id);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeId('Issue', repo.id, issue.number);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return encodeId('PullRequest', repo.id, pull.number);
}

function commentGlobalId(repo: Repo, commentId: number): string {
  return encodeId('Comment', repo.id, commentId);
}

/** Find a repository by its numeric database id (the global id's payload). */
function repoByDatabaseId(store: ForgeStore, id: number): Repo | null {
  for (const repo of store.repos.values()) {
    if (repo.id === id) return repo;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Document parsing (a recursive-descent parser for the documented shapes).
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[] | null;
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: string[];
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class ParseError extends Error {}

function tokenize(source: string): string[] {
  // Tokens: names, numbers, strings, the spread "...", and single punctuation.
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j]!;
          j += 1;
        }
      }
      if (j >= source.length) throw new ParseError('unterminated string');
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (ch === '$') {
      tokens.push('$');
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if ('{}():![]=@'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new ParseError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new ParseError(`expected ${token}, got ${got}`);
  }

  private isName(token: string | undefined): boolean {
    return token !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token) && !['query', 'mutation', 'fragment', 'on', 'true', 'false', 'null'].includes(token);
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === 'query' || token === 'mutation') {
        operations.push(this.parseOperation());
      } else if (token === 'fragment') {
        const fragment = this.parseFragment();
        fragments.set(fragment.name, fragment);
      } else if (token === '{') {
        operations.push({
          kind: 'operation',
          operation: 'query',
          name: null,
          variableDefinitions: [],
          selections: this.parseSelectionSet(),
        });
      } else {
        throw new ParseError(`unexpected token ${token} at the top level`);
      }
    }
    if (operations.length === 0) throw new ParseError('the document holds no operation');
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    const operation = this.next() as 'query' | 'mutation';
    let name: string | null = null;
    if (this.isName(this.peek())) name = this.next();
    const variableDefinitions: string[] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.peek() !== undefined) {
        if (this.peek() === '$') {
          this.next();
          variableDefinitions.push(this.next());
        } else {
          this.next();
        }
      }
      this.expect(')');
    }
    const selections = this.parseSelectionSet();
    return { kind: 'operation', operation, name, variableDefinitions, selections };
  }

  private parseFragment(): FragmentNode {
    this.expect('fragment');
    const name = this.next();
    this.expect('on');
    const typeCondition = this.next();
    const selections = this.parseSelectionSet();
    return { kind: 'fragment', name, typeCondition, selections };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}' && this.peek() !== undefined) {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const typeCondition = this.next();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.isName(this.peek())) {
        return { kind: 'spread', name: this.next() };
      }
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.next();
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.peek() !== undefined) {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    let selections: SelectionNode[] | null = null;
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (token === '[') {
      const items: ValueNode[] = [];
      while (this.peek() !== ']' && this.peek() !== undefined) items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek() !== '}' && this.peek() !== undefined) {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d+\.\d+([eE][+-]?\d+)?$/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) return { kind: 'enum', value: token };
    throw new ParseError(`cannot parse value ${token}`);
  }
}

/** Evaluate an argument value against the operation's variables. */
function evaluateValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      return variables[node.name] ?? null;
    }
    case 'string':
      return node.value;
    case 'int':
    case 'float':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => evaluateValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evaluateValue(field.value, variables);
      return out;
    }
  }
}

function evaluateArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evaluateValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// The schema: every type the checks read, with its fields and their resolvers.
// ---------------------------------------------------------------------------

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

interface FieldDef {
  /** The GraphQL type of the field's value (a list is written `[T]`). */
  type: string;
  resolve: (source: GqlObject, args: Record<string, unknown>, ctx: GqlContext) => unknown;
}

interface GqlContext {
  store: ForgeStore;
}

function scalar(type: string, value: (source: GqlObject) => unknown): FieldDef {
  return { type, resolve: (source) => value(source) };
}

function userObject(): GqlObject {
  return { __typename: 'User', login: VIEWER_LOGIN };
}

function refObject(name: string): GqlObject {
  return { __typename: 'Ref', name };
}

function issueObject(store: ForgeStore, repo: Repo, issue: Issue): GqlObject {
  return {
    __typename: 'Issue',
    id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    __repo: repo,
    __issue: issue,
  };
}

function pullObject(store: ForgeStore, repo: Repo, pull: Pull): GqlObject {
  return {
    __typename: 'PullRequest',
    id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    __repo: repo,
    __pull: pull,
  };
}

function repoObject(store: ForgeStore, repo: Repo): GqlObject {
  return {
    __typename: 'Repository',
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    __repo: repo,
  };
}

/** The cursor after an issue number in a paged list (opaque, stable). */
function issueCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1], 10);
  } catch {
    return null;
  }
}

/** The issues connection for a repository, with states/order/cursor/first applied. */
function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state)));
    list = list.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
  list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const afterNumber = cursorNumber(args.after);
  if (afterNumber !== null) {
    list = list.filter((issue) => (direction === 'ASC' ? issue.number > afterNumber : issue.number < afterNumber));
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : list.length;
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? issueCursor(page[page.length - 1]!.number) : null;
  return {
    __typename: 'IssueConnection',
    __nodes: page,
    __repo: repo,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      endCursor,
    },
  };
}

function pullRequestsConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : repo.pulls.length;
  return {
    __typename: 'PullRequestConnection',
    __nodes: [...repo.pulls].sort((a, b) => a.number - b.number).slice(0, first),
    __repo: repo,
  };
}

function pullFilesConnection(store: ForgeStore, repo: Repo, pull: Pull, args: Record<string, unknown>): GqlObject {
  const headCommit = repo.objects.get(pull.headSha);
  const baseCommit = repo.objects.get(pull.baseSha);
  let paths: string[] = [];
  if (headCommit !== undefined && baseCommit !== undefined) {
    const headTree = parseCommit(headCommit.data).tree;
    const baseTree = parseCommit(baseCommit.data).tree;
    paths = store.diffTrees(repo, baseTree, headTree).map((change) => change.filename);
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : paths.length;
  return {
    __typename: 'PullRequestChangedFileConnection',
    __nodes: paths.slice(0, first).map((path) => ({ __typename: 'PullRequestChangedFile', path })),
  };
}

function mergeableOf(store: ForgeStore, repo: Repo, pull: Pull): string {
  if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
  return store.pullRequestConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url'];
const PULL_REQUEST_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
  'headRefOid', 'baseRefOid', 'files', 'createdAt', 'mergedAt', 'mergeCommit', 'author',
];
const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
  'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt',
];
const SEARCH_TYPE_VALUES = [
  'ISSUE', 'REPOSITORY', 'USER', 'CODE', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'WIKI', 'TOPIC',
  'PACKAGE', 'MARKETPLACE', 'PROJECT', 'TEAM', 'ORGANIZATION', 'APP', 'TEXT_MATCH',
];

function typeDescriptor(name: string): GqlObject | null {
  if (name === 'Issue') {
    return { __typename: '__Type', name: 'Issue', kind: 'OBJECT', fields: ISSUE_FIELDS.map((field) => ({ __typename: '__Field', name: field })), enumValues: null };
  }
  if (name === 'PullRequest') {
    return { __typename: '__Type', name: 'PullRequest', kind: 'OBJECT', fields: PULL_REQUEST_FIELDS.map((field) => ({ __typename: '__Field', name: field })), enumValues: null };
  }
  if (name === 'Repository') {
    return { __typename: '__Type', name: 'Repository', kind: 'OBJECT', fields: REPOSITORY_FIELDS.map((field) => ({ __typename: '__Field', name: field })), enumValues: null };
  }
  if (name === 'SearchType') {
    return { __typename: '__Type', name: 'SearchType', kind: 'ENUM', fields: null, enumValues: SEARCH_TYPE_VALUES.map((value) => ({ __typename: '__EnumValue', name: value })) };
  }
  return null;
}

const SCHEMA: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: { type: 'User', resolve: () => userObject() },
    repository: {
      type: 'Repository',
      resolve: (_source, args, ctx) => {
        const owner = args.owner;
        const name = args.name;
        if (typeof owner !== 'string' || typeof name !== 'string') return null;
        if (owner !== VIEWER_LOGIN) return null;
        const repo = ctx.store.getRepo(owner, name);
        return repo === undefined ? null : repoObject(ctx.store, repo);
      },
    },
    node: {
      // A node always resolves to a Repository here, so its selections read Repository fields.
      type: 'Repository',
      resolve: (_source, args, ctx) => {
        const decoded = decodeId(args.id as string);
        if (decoded === null || decoded.kind !== 'Repository') return null;
        const repo = repoByDatabaseId(ctx.store, Number(decoded.parts[0]));
        return repo === null ? null : repoObject(ctx.store, repo);
      },
    },
    __type: {
      type: '__Type',
      resolve: (_source, args) => {
        const name = args.name;
        return typeof name === 'string' ? typeDescriptor(name) : null;
      },
    },
  },
  User: {
    login: scalar('String', (source) => source.login),
  },
  Repository: {
    id: scalar('ID', (source) => source.id),
    databaseId: scalar('Int', (source) => source.databaseId),
    name: scalar('String', (source) => source.name),
    nameWithOwner: scalar('String', (source) => source.nameWithOwner),
    description: scalar('String', (source) => source.description ?? ''),
    owner: { type: 'User', resolve: (source) => userObject() },
    defaultBranchRef: {
      type: 'Ref',
      resolve: (source, _args, ctx) => {
        const repo = source.__repo as Repo;
        const tip = ctx.store.defaultTip(repo);
        return tip === undefined ? null : refObject(repo.defaultBranch);
      },
    },
    viewerPermission: scalar('RepositoryPermission', () => 'ADMIN'),
    hasIssuesEnabled: scalar('Boolean', () => true),
    issue: {
      type: 'Issue',
      resolve: (source, args, ctx) => {
        const repo = source.__repo as Repo;
        const number = args.number;
        if (typeof number !== 'number') return null;
        const issue = repo.issues.find((item) => item.number === number);
        return issue === undefined ? null : issueObject(ctx.store, repo, issue);
      },
    },
    issues: {
      type: 'IssueConnection',
      resolve: (source, args) => issuesConnection(source.__repo as Repo, args),
    },
    pullRequests: {
      type: 'PullRequestConnection',
      resolve: (source, args) => pullRequestsConnection(source.__repo as Repo, args),
    },
    pullRequest: {
      type: 'PullRequest',
      resolve: (source, args, ctx) => {
        const repo = source.__repo as Repo;
        const number = args.number;
        if (typeof number !== 'number') return null;
        const pull = repo.pulls.find((item) => item.number === number);
        return pull === undefined ? null : pullObject(ctx.store, repo, pull);
      },
    },
  },
  Ref: {
    name: scalar('String', (source) => source.name),
  },
  Issue: {
    id: scalar('ID', (source) => source.id),
    number: scalar('Int', (source) => source.number),
    title: scalar('String', (source) => source.title),
    state: scalar('IssueState', (source) => source.state),
    body: scalar('String', (source) => source.body ?? ''),
  },
  IssueConnection: {
    nodes: {
      type: '[Issue]',
      resolve: (source, _args, ctx) => {
        const repo = source.__repo as Repo;
        return (source.__nodes as Issue[]).map((issue) => issueObject(ctx.store, repo, issue));
      },
    },
    pageInfo: { type: 'PageInfo', resolve: (source) => source.pageInfo as GqlObject },
  },
  PageInfo: {
    hasNextPage: scalar('Boolean', (source) => source.hasNextPage),
    endCursor: scalar('String', (source) => source.endCursor ?? null),
  },
  PullRequestConnection: {
    nodes: {
      type: '[PullRequest]',
      resolve: (source, _args, ctx) => {
        const repo = source.__repo as Repo;
        return (source.__nodes as Pull[]).map((pull) => pullObject(ctx.store, repo, pull));
      },
    },
  },
  PullRequest: {
    id: scalar('ID', (source) => source.id),
    number: scalar('Int', (source) => source.number),
    title: scalar('String', (source) => source.title),
    body: scalar('String', (source) => source.body ?? ''),
    state: scalar('PullRequestState', (source) => source.state),
    merged: scalar('Boolean', (source) => source.merged),
    headRefName: scalar('String', (source) => source.headRefName),
    baseRefName: scalar('String', (source) => source.baseRefName),
    mergeable: {
      type: 'MergeableState',
      resolve: (source, _args, ctx) => mergeableOf(ctx.store, source.__repo as Repo, source.__pull as Pull),
    },
    files: {
      type: 'PullRequestChangedFileConnection',
      resolve: (source, args, ctx) => pullFilesConnection(ctx.store, source.__repo as Repo, source.__pull as Pull, args),
    },
  },
  PullRequestChangedFileConnection: {
    nodes: { type: '[PullRequestChangedFile]', resolve: (source) => source.__nodes as GqlObject[] },
  },
  PullRequestChangedFile: {
    path: scalar('String', (source) => source.path),
  },
  __Type: {
    name: scalar('String', (source) => source.name),
    kind: scalar('String', (source) => source.kind ?? null),
    fields: {
      type: '[__Field]',
      resolve: (source) => (source.fields as GqlObject[] | null) ?? [],
    },
    enumValues: {
      type: '[__EnumValue]',
      resolve: (source) => (source.enumValues as GqlObject[] | null) ?? [],
    },
  },
  __Field: {
    name: scalar('String', (source) => source.name),
  },
  __EnumValue: {
    name: scalar('String', (source) => source.name),
  },
  Mutation: {
    createIssue: {
      type: 'CreateIssuePayload',
      resolve: (_source, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeId(input.repositoryId as string);
        if (decoded === null || decoded.kind !== 'Repository') throw new Error('createIssue: the repositoryId does not name a repository');
        const repo = repoByDatabaseId(ctx.store, Number(decoded.parts[0]));
        if (repo === null) throw new Error('createIssue: the repository does not exist');
        const title = input.title;
        if (typeof title !== 'string' || title === '') throw new Error('createIssue: a title is required');
        repo.issueSeq += 1;
        const createdAt = ctx.store.nextIso();
        const issue: Issue = {
          number: repo.issueSeq,
          title,
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: [],
          createdAt,
          updatedAt: createdAt,
          createdSeq: repo.issueSeq,
        };
        repo.issues.push(issue);
        return { __typename: 'CreateIssuePayload', issue: issueObject(ctx.store, repo, issue) };
      },
    },
    closeIssue: {
      type: 'CloseIssuePayload',
      resolve: (_source, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeId(input.issueId as string);
        if (decoded === null || decoded.kind !== 'Issue') throw new Error('closeIssue: the issueId does not name an issue');
        const repo = repoByDatabaseId(ctx.store, Number(decoded.parts[0]));
        if (repo === null) throw new Error('closeIssue: the repository does not exist');
        const issue = repo.issues.find((item) => item.number === Number(decoded.parts[1]));
        if (issue === undefined) throw new Error('closeIssue: the issue does not exist');
        issue.state = 'closed';
        issue.updatedAt = ctx.store.nextIso();
        return { __typename: 'CloseIssuePayload', issue: issueObject(ctx.store, repo, issue) };
      },
    },
    createPullRequest: {
      type: 'CreatePullRequestPayload',
      resolve: (_source, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeId(input.repositoryId as string);
        if (decoded === null || decoded.kind !== 'Repository') throw new Error('createPullRequest: the repositoryId does not name a repository');
        const repo = repoByDatabaseId(ctx.store, Number(decoded.parts[0]));
        if (repo === null) throw new Error('createPullRequest: the repository does not exist');
        const head = input.headRefName;
        const base = input.baseRefName;
        const title = input.title;
        if (typeof head !== 'string' || typeof base !== 'string' || typeof title !== 'string' || title === '') {
          throw new Error('createPullRequest: headRefName, baseRefName and title are required');
        }
        const headSha = ctx.store.resolveRef(repo, head);
        const baseSha = ctx.store.resolveRef(repo, base);
        if (headSha === undefined || baseSha === undefined) throw new Error('createPullRequest: head and base must be existing branches');
        repo.pullSeq += 1;
        const pull: Pull = {
          number: repo.pullSeq,
          title,
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          headRef: head,
          baseRef: base,
          headSha,
          baseSha,
          mergeBaseSha: baseSha,
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          createdAt: ctx.store.nextIso(),
          createdSeq: repo.pullSeq,
        };
        repo.pulls.push(pull);
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(ctx.store, repo, pull) };
      },
    },
    mergePullRequest: {
      type: 'MergePullRequestPayload',
      resolve: (_source, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeId(input.pullRequestId as string);
        if (decoded === null || decoded.kind !== 'PullRequest') throw new Error('mergePullRequest: the pullRequestId does not name a pull request');
        const repo = repoByDatabaseId(ctx.store, Number(decoded.parts[0]));
        if (repo === null) throw new Error('mergePullRequest: the repository does not exist');
        const pull = repo.pulls.find((item) => item.number === Number(decoded.parts[1]));
        if (pull === undefined) throw new Error('mergePullRequest: the pull request does not exist');
        const merged = ctx.store.mergePullRequest(repo, pull);
        if (!merged.ok) throw new Error(`mergePullRequest: ${merged.message}`);
        return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(ctx.store, repo, pull) };
      },
    },
    addComment: {
      type: 'AddCommentPayload',
      resolve: (_source, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeId(input.subjectId as string);
        if (decoded === null || decoded.kind !== 'Issue') throw new Error('addComment: the subjectId does not name an issue');
        const repo = repoByDatabaseId(ctx.store, Number(decoded.parts[0]));
        if (repo === null) throw new Error('addComment: the repository does not exist');
        const issue = repo.issues.find((item) => item.number === Number(decoded.parts[1]));
        if (issue === undefined) throw new Error('addComment: the issue does not exist');
        const body = input.body;
        if (typeof body !== 'string' || body === '') throw new Error('addComment: a body is required');
        repo.commentSeq += 1;
        const comment = { id: repo.commentSeq, body, createdAt: ctx.store.nextIso() };
        const list = repo.comments.get(issue.number) ?? [];
        list.push(comment);
        repo.comments.set(issue.number, list);
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: { __typename: 'IssueComment', id: commentGlobalId(repo, comment.id), body: comment.body },
          },
        };
      },
    },
  },
  CreateIssuePayload: {
    issue: { type: 'Issue', resolve: (source) => source.issue as GqlObject },
  },
  CloseIssuePayload: {
    issue: { type: 'Issue', resolve: (source) => source.issue as GqlObject },
  },
  CreatePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: (source) => source.pullRequest as GqlObject },
  },
  MergePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: (source) => source.pullRequest as GqlObject },
  },
  AddCommentPayload: {
    commentEdge: { type: 'IssueCommentEdge', resolve: (source) => source.commentEdge as GqlObject },
  },
  IssueCommentEdge: {
    node: { type: 'IssueComment', resolve: (source) => source.node as GqlObject },
  },
  IssueComment: {
    id: scalar('ID', (source) => source.id),
    body: scalar('String', (source) => source.body ?? ''),
  },
};

// ---------------------------------------------------------------------------
// Execution: walk the selection set against the schema, collecting errors.
// ---------------------------------------------------------------------------

interface ExecutionResult {
  data: Record<string, unknown> | null;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

/** The field's value type without its list brackets. */
function baseType(type: string): string {
  return type.replace(/^\[/, '').replace(/\]$/, '');
}

function resolveSelections(
  typeName: string,
  source: GqlObject | null,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  fragments: Map<string, FragmentNode>,
  ctx: GqlContext,
  errors: Array<{ message: string; path?: Array<string | number> }>,
  path: Array<string | number>,
): Record<string, unknown> | null {
  if (source === null) return null;
  const out: Record<string, unknown> = {};
  const fields = SCHEMA[typeName] ?? {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = fragments.get(selection.name);
      if (fragment === undefined) {
        errors.push({ message: `Unknown fragment "${selection.name}".`, path: [...path] });
        continue;
      }
      const nested = resolveSelections(typeName, source, fragment.selections, variables, fragments, ctx, errors, path);
      if (nested !== null) Object.assign(out, nested);
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName && selection.typeCondition !== source.__typename) {
        continue;
      }
      const nested = resolveSelections(typeName, source, selection.selections, variables, fragments, ctx, errors, path);
      if (nested !== null) Object.assign(out, nested);
      continue;
    }
    const key = selection.alias ?? selection.name;
    const def = fields[selection.name];
    if (def === undefined) {
      errors.push({
        message: `Cannot query field "${selection.name}" on type "${typeName}".`,
        path: [...path, key],
      });
      continue;
    }
    const args = evaluateArgs(selection, variables);
    let value: unknown;
    try {
      value = def.resolve(source, args, ctx);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), path: [...path, key] });
      out[key] = null;
      continue;
    }
    if (selection.selections === null) {
      out[key] = value;
      continue;
    }
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    const valueType = baseType(def.type);
    if (Array.isArray(value)) {
      out[key] = value.map((item, index) =>
        item !== null && typeof item === 'object'
          ? resolveSelections(valueType, item as GqlObject, selection.selections!, variables, fragments, ctx, errors, [...path, key, index])
          : item,
      );
    } else if (typeof value === 'object') {
      out[key] = resolveSelections(valueType, value as GqlObject, selection.selections, variables, fragments, ctx, errors, [...path, key]);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Execute one operation document against the store. */
export function executeGraphQL(
  store: ForgeStore,
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): ExecutionResult {
  const errors: Array<{ message: string; path?: Array<string | number> }> = [];
  let document: DocumentNode;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation =
    operationName === undefined
      ? document.operations[0]!
      : document.operations.find((op) => op.name === operationName) ?? document.operations[0]!;
  if (operation === undefined) {
    return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
  }
  const ctx: GqlContext = { store };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __typename: rootType };
  const data = resolveSelections(rootType, root, operation.selections, variables, document.fragments, ctx, errors, []);
  if (errors.length > 0) return { data: null, errors };
  return { data, errors: [] };
}

// ---------------------------------------------------------------------------
// HTTP: one operation, or a JSON array of them (GitHub's operation batching).
// ---------------------------------------------------------------------------

export interface GraphQLHttpResult {
  status: number;
  body: Buffer;
}

/** Handle a POST /api/graphql body (already parsed JSON, or null when it did not parse). */
export function handleGraphQL(store: ForgeStore, parsed: unknown): GraphQLHttpResult {
  const respond = (value: unknown): GraphQLHttpResult => ({
    status: 200,
    body: Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'),
  });
  if (parsed === null) {
    return { status: 400, body: Buffer.from(`${JSON.stringify({ errors: [{ message: 'the request body is not valid JSON' }] })}\n`, 'utf8') };
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'each operation must be an object with a query string' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = record.query;
    if (typeof query !== 'string' || query === '') {
      return { data: null, errors: [{ message: 'an operation needs a query string' }] };
    }
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
    const { data, errors } = executeGraphQL(store, query, variables, operationName);
    return errors.length > 0 ? { data, errors } : { data };
  };
  if (Array.isArray(parsed)) {
    return respond(parsed.map((entry) => runOne(entry)));
  }
  return respond(runOne(parsed));
}
