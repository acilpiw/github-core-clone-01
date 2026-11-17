// lib/git-http.ts — the git smart-HTTP surface: info/refs advertisements (v2 and v0),
// upload-pack (ls-refs and fetch, v2 and v0) and receive-pack (push). Hand-written against
// the wire contract; the pack/object work lives in lib/git.ts, the state in lib/store.ts.

import {
  collectReachable,
  decodePktLines,
  decodePktLinesPrefix,
  encodePktLine,
  encodePktLines,
  hashObject,
  isFastForward,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktLineFlush,
  readPack,
  sidebandPackets,
  verifyPackChecksum,
  writePack,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
} from './git.ts';
import { ForgeStore, VIEWER_LOGIN, type Repo } from './store.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function json404(message: string): GitResponse {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

function json400(message: string): GitResponse {
  return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

/**
 * The v0 advertisement ref lines. The first line carries the capabilities after a NUL
 * (for an empty repo that line is the `capabilities^{}` zero line); HEAD is listed only
 * when the default branch exists.
 */
function v0RefLines(repo: Repo, caps: string): string[] {
  const lines: string[] = [];
  const refs = repoSortedRefs(repo);
  const main = refs.find((ref) => ref.name === 'refs/heads/main');
  if (refs.length === 0) {
    return [`${ZERO_OID} capabilities^{}\u0000${caps}`];
  }
  const entries: Array<{ oid: string; name: string }> = [];
  if (main) entries.push({ oid: main.oid, name: 'HEAD' });
  for (const ref of refs) entries.push(ref);
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    let line = `${entry.oid} ${entry.name}`;
    if (i === 0) line += `\u0000${caps}`;
    lines.push(line);
    if (entry.name.startsWith('refs/tags/')) {
      const object = repo.objects.get(entry.oid);
      if (object && object.type === 'tag') {
        lines.push(`${parseTag(object.data).object} ${entry.name}^{}`);
      }
    }
  }
  return lines;
}

function repoSortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The upload-pack v0 capabilities, on the first advertisement line. */
const UPLOAD_V0_CAPS = 'symref=HEAD:refs/heads/main side-band-64k ofs-delta';
/** The receive-pack v0 capabilities, on the first advertisement line. */
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main';

/**
 * GET /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack.
 * `gitProtocol` is the Git-Protocol request header, if any.
 */
export function handleInfoRefs(
  store: ForgeStore,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string | null,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return json404('Not Found');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return json400('unknown service');

  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    // Protocol v2: a capability advertisement, no ref list.
    const body = encodePktLines(['version 2\n', 'ls-refs\n', 'fetch=shallow\n', 'object-format=sha1\n', 'flush']);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }

  // Protocol v0: the service preamble, then the ref lines with capabilities on the first.
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const lines = v0RefLines(repo, caps);
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`)];
  for (const line of lines) parts.push(encodePktLine(`${line}\n`));
  parts.push(pktLineFlush());
  const body = Buffer.concat(parts);
  const contentType =
    service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';
  return { status: 200, contentType, body };
}

// ---------------------------------------------------------------------------
// upload-pack: ls-refs
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(lines: readonly string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, prefixes: [] };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') args.peel = true;
    else if (text === 'symrefs') args.symrefs = true;
    else if (text === 'unborn') { /* never emitted: an empty repo lists no refs */ }
    else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
    // agent= and object-format= lines are accepted and ignored.
  }
  return args;
}

/**
 * The v2 ls-refs reply: one line per ref, `<oid> <name>[ symref-target:X][ peeled:Y]`.
 * HEAD is listed (with its symref target) unless a ref-prefix excludes it.
 */
export function lsRefsReply(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const main = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (main !== undefined && keep('HEAD')) {
    lines.push(`${main} HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}`);
  }
  for (const ref of repoSortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (ref.name.startsWith('refs/tags/')) {
      const object = repo.objects.get(ref.oid);
      if (object && object.type === 'tag') {
        line += ` peeled:${parseTag(object.data).object}`;
      }
    }
    lines.push(line);
  }
  const parts = lines.map((line) => encodePktLine(`${line}\n`));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack: fetch
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, done, agent=, object-format= are accepted.
  }
  return args;
}

interface FetchPlan {
  /** Objects to send, by id, in a stable order. */
  send: GitObject[];
  /** The new shallow boundary (commits at the depth cut), sorted. */
  shallow: string[];
  /** Old shallow boundaries that are no longer shallow, sorted. */
  unshallow: string[];
  /** The first have that is a common ancestor of a want, if any (for the ACK line). */
  ackHave: string | null;
}

/**
 * Work out what a fetch sends. `held` is what the client already has: the full closure of
 * each have, except a have that is one of the client's shallow boundaries, whose parents
 * are NOT held (a shallow clone holds the boundary commit and its tree, not its history).
 * With a depth limit, only commits within the depth of a want are included, and the boundary
 * commits at the cut become the new shallow set.
 */
function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const shallowSet = new Set(args.shallow);

  // What the client holds.
  const held = new Set<string>();
  {
    const queue: string[] = [...args.haves];
    while (queue.length) {
      const oid = queue.pop()!;
      if (held.has(oid)) continue;
      const object = lookup(oid);
      if (!object) continue;
      held.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        if (!shallowSet.has(oid)) {
          for (const parent of commit.parents) queue.push(parent);
        }
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) queue.push(entry.oid);
      }
    }
  }

  // What the fetch includes: commits within depth of a want, plus their tree closures.
  const depth = args.depth ?? Number.POSITIVE_INFINITY;
  const included = new Set<string>();
  const boundary = new Set<string>();
  {
    interface Work {
      oid: string;
      distance: number;
    }
    const queue: Work[] = args.wants.map((oid) => ({ oid, distance: 0 }));
    const seenCommit = new Set<string>();
    const addTreeClosure = (treeOid: string): void => {
      const stack: string[] = [treeOid];
      while (stack.length) {
        const oid = stack.pop()!;
        if (included.has(oid)) continue;
        const object = lookup(oid);
        if (!object) continue;
        included.add(oid);
        if (object.type === 'tree') {
          for (const entry of parseTree(object.data)) stack.push(entry.oid);
        }
      }
    };
    while (queue.length) {
      const { oid, distance } = queue.pop()!;
      const object = lookup(oid);
      if (!object) continue;
      if (object.type === 'commit') {
        if (distance >= depth || seenCommit.has(oid)) continue;
        seenCommit.add(oid);
        included.add(oid);
        const commit = parseCommit(object.data);
        addTreeClosure(commit.tree);
        if (distance + 1 >= depth) boundary.add(oid);
        else for (const parent of commit.parents) queue.push({ oid: parent, distance: distance + 1 });
      } else if (object.type === 'tag') {
        if (included.has(oid)) continue;
        included.add(oid);
        queue.push({ oid: parseTag(object.data).object, distance });
      } else {
        included.add(oid);
      }
    }
  }

  const send: GitObject[] = [];
  for (const oid of [...included].sort()) {
    if (held.has(oid)) continue;
    const object = lookup(oid);
    if (object) send.push(object);
  }

  const unshallow = args.shallow.filter((oid) => included.has(oid) && !boundary.has(oid)).sort();
  const shallow = [...boundary].sort();

  let ackHave: string | null = null;
  if (args.haves.length > 0) {
    const wantClosure = new Set<string>();
    try {
      for (const oid of collectReachable(args.wants, lookup, { allowMissing: true })) wantClosure.add(oid);
    } catch {
      // a missing want contributes nothing
    }
    ackHave = args.haves.find((have) => wantClosure.has(have)) ?? null;
  }

  return { send, shallow, unshallow, ackHave };
}

/** The v2 fetch reply: acknowledgments, shallow-info and packfile sections, each flushed. */
function v2FetchReply(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  if (plan.ackHave !== null) {
    parts.push(encodePktLine(`ACK ${plan.ackHave}\n`));
    parts.push(encodePktLine('ready\n'));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  parts.push(pktLineFlush());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktLineFlush());
  }
  parts.push(encodePktLine('packfile\n'));
  const pack = writePack(plan.send);
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

/** The v0 fetch reply: NAK/ACK and shallow lines, then the sideband pack, then a flush. */
function v0FetchReply(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  parts.push(encodePktLine(plan.ackHave !== null ? `ACK ${plan.ackHave}\n` : 'NAK\n'));
  if (plan.ackHave !== null) parts.push(encodePktLine('ready\n'));
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  const pack = writePack(plan.send);
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

/**
 * POST /{owner}/{repo}.git/git-upload-pack. The body is one pkt-line command (v2) or the
 * two-section want/have exchange (v0). A malformed body is a 400; the server stays up.
 */
export function handleUploadPack(
  store: ForgeStore,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocol: string | null,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return json404('Not Found');
  const contentType = 'application/x-git-upload-pack-result';
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return json400('malformed pkt-line stream');
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    else if (packet.kind === 'delim') lines.push('\u0001');
    else if (packet.kind === 'flush') lines.push('\u0000');
  }
  if (gitProtocol === 'version=2') {
    const commandLine = lines[0] ?? '';
    if (commandLine.startsWith('command=ls-refs')) {
      const delimAt = lines.indexOf('\u0001');
      const argLines = delimAt < 0 ? lines.slice(1) : lines.slice(delimAt + 1);
      const args = parseLsRefsArgs(argLines.filter((line) => line !== '\u0000'));
      return { status: 200, contentType, body: lsRefsReply(repo, args) };
    }
    if (commandLine.startsWith('command=fetch')) {
      const delimAt = lines.indexOf('\u0001');
      const argLines = delimAt < 0 ? lines.slice(1) : lines.slice(delimAt + 1);
      const args = parseFetchArgs(argLines.filter((line) => line !== '\u0000'));
      const plan = planFetch(repo, args);
      return { status: 200, contentType, body: v2FetchReply(plan) };
    }
    return json400('unknown v2 command');
  }
  // Protocol v0: wants in the first section, haves and done in the second.
  const flushAt = lines.indexOf('\u0000');
  const first = flushAt < 0 ? lines : lines.slice(0, flushAt);
  const second = flushAt < 0 ? [] : lines.slice(flushAt + 1);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of first) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).split(' ')[0]);
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
  }
  for (const line of second) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
  }
  if (args.wants.length === 0) return json400('a v0 fetch needs a want');
  const plan = planFetch(repo, args);
  return { status: 200, contentType, body: v0FetchReply(plan) };
}

// ---------------------------------------------------------------------------
// receive-pack: push
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * POST /{owner}/{repo}.git/git-receive-pack. Parses the command list and the pack that
 * follows its flush packet, unpacks and validates the objects, applies the ref updates
 * with the fast-forward rule, and answers a sideband report-status stream.
 */
export function handleReceivePack(store: ForgeStore, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return json404('Not Found');
  const contentType = 'application/x-git-receive-pack-result';

  let prefix;
  try {
    prefix = decodePktLinesPrefix(body);
  } catch {
    return json400('malformed pkt-line stream');
  }
  const commands: PushCommand[] = [];
  let sawFlush = false;
  for (const packet of prefix.packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\u0000');
    const head = nul < 0 ? text : text.slice(0, nul);
    const parts = head.split(' ');
    if (parts.length < 3) return json400('bad push command');
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) {
      return json400('bad push command');
    }
    commands.push({ oldOid, newOid, ref });
  }
  if (!sawFlush || commands.length === 0) return json400('a push needs a command list');
  const packBytes = body.subarray(prefix.consumed);
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);

  // Unpack: a pack must be present for any create/update, and it must be whole.
  let unpackError: string | null = null;
  let packObjects: Map<string, GitObject> | null = null;
  if (updatesRef) {
    if (packBytes.length === 0) {
      unpackError = 'no pack received';
    } else {
      const checksum = verifyPackChecksum(packBytes);
      if (!checksum.ok) {
        unpackError = 'pack checksum mismatch';
      } else {
        try {
          const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
          packObjects = read.objects;
        } catch (err) {
          unpackError = err instanceof Error ? err.message : 'pack did not parse';
        }
      }
    }
  }
  if (unpackError === null && packObjects !== null) {
    // Every new tip's closure must exist, in the pack or already on the server.
    const lookup = (oid: string): GitObject | undefined => packObjects!.get(oid) ?? repo.objects.get(oid);
    for (const command of commands) {
      if (command.newOid === ZERO_OID) continue;
      try {
        collectReachable([command.newOid], lookup);
      } catch (err) {
        unpackError = err instanceof Error ? err.message : `object ${command.newOid} is missing`;
        break;
      }
      const object = lookup(command.newOid);
      if (!object || (object.type !== 'commit' && object.type !== 'tag')) {
        unpackError = `ref ${command.ref} must point at a commit or a tag`;
        break;
      }
    }
  }

  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}`);
  } else {
    if (packObjects !== null) {
      for (const [oid, object] of packObjects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    }
    reportLines.push('unpack ok');
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          reportLines.push(`ng ${command.ref} no such ref`);
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          reportLines.push(`ng ${command.ref} old value mismatch`);
        } else {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}`);
        }
        continue;
      }
      if (current === undefined) {
        // Create.
        if (command.oldOid !== ZERO_OID) {
          reportLines.push(`ng ${command.ref} no such ref`);
        } else {
          repo.refs.set(command.ref, command.newOid);
          reportLines.push(`ok ${command.ref}`);
        }
        continue;
      }
      // Update.
      if (command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} old value mismatch`);
        continue;
      }
      if (command.ref.startsWith('refs/tags/')) {
        reportLines.push(`ng ${command.ref} cannot update tag`);
        continue;
      }
      const object = lookup(command.newOid);
      if (!object || object.type !== 'commit') {
        reportLines.push(`ng ${command.ref} new tip is not a commit`);
        continue;
      }
      if (!isFastForward(command.newOid, current, lookup)) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}`);
    }
  }

  // The report-status stream, pkt-lined inside sideband band 1, then a top-level flush.
  const reportBody = encodePktLines(reportLines.map((line) => `${line}\n`));
  const parts: Buffer[] = [];
  for (const packet of sidebandPackets(1, reportBody)) parts.push(packet);
  parts.push(pktLineFlush());
  return { status: 200, contentType, body: Buffer.concat(parts) };
}
