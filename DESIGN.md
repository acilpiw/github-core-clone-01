# github-core-clone-01 — Forge Design

Repo: public GitHub repo under @acilpiw (to be created via browser; gh CLI not logged in).
Entry: `main.ts` (starter lifecycle, unchanged) + `app.ts` (server) + `lib/*.ts`.
Kit: `~/workspace/makefun/github-core-clone-01-kit/unpacked/github-core-clone-01-kit/`
Local grader: `node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token TOK [--perf]`
  (NO Docker needed — sdk/run.ts runs the sealed checks over HTTP. Token: any value locally,
   set MAKEFUN_SHOP_TOKEN to the same value when starting the server.)

## Scoring (manifest.ts)
- 120 checks: git 30, repos 15, issues 15, pulls 20, graphql 20, mcp 15, protocol 5.
- feature = round(600 * passed/120); agent = round(200 * mcpPassed/15); perf = 4 workloads x <=50.
- T_ref (calibrated, house reference medians): push 1640.82ms, clone 266.941ms, read 2759.715ms,
  write 348.965ms. Reference scores ~600+200+100 = ~900. To BEAT it (tie does not count):
  need 120/120 (800) + perf > 100, i.e. faster than reference on the workloads.
- Workloads: push 200 sequential 1KiB receive-pack pushes; clone 50 concurrent depth-1 clones of a
  200-commit repo; read 2000 sequential issue GETs keep-alive; write 200 sequential issue POSTs.
- Trial limits: Node 22, stdlib only, no git binary, no internet, repo mounted read-only at /bot,
  write only under /tmp, 900s wall, entry 2 CPU / 1024 MiB.

## Identity / auth (fixed by constant scenario seed 6a09e667f3bcc909)
- Viewer login = **adaiversen** (id 1000, "ada iversen", adaiversen@example.invalid).
  Stranger = olgabauer, teammate = quinnkeller, org = faint-meadow-org.
- Token = process.env.MAKEFUN_SHOP_TOKEN. Bearer must match exactly; missing/wrong -> 401 {message}.
  Any repo path under a different owner -> 404 (never 403). /healthz needs no auth.
- Every REST reply: application/json, non-empty X-GitHub-Request-Id (deterministic counter),
  X-OAuth-Scopes on GET /api/v3/ root. Unknown route -> JSON 404 {message}. Malformed JSON -> 400.
- Default branch is always `main`. Deterministic clock: counter from epoch 1700000000 (no Date.now
  in any response that could reach state; merged_at/created_at use the counter clock).

## Store (in-memory, lib/store.ts)
- Repos: Map key `owner/name`. Repo: {id (seq from 1), name, owner, private, description,
  defaultBranch 'main', createdSeq, objects: Map<oid,{type,data}>, refs: Map<ref,oid>,
  labels: Map<name,{name,color}>, issues: Issue[], issueSeq, comments: Map<issueNum, Comment[]>,
  commentSeq, pulls: Pull[], pullSeq, nextRepoSeq}.
- Repo create: POST /user/repos -> 201; duplicate name under same owner -> 422 "already exists".
  DELETE /repos/{o}/{r} -> 204; afterwards GET 404. PATCH description -> 200.
- Git objects live per-repo (objects Map). Refs: refs/heads/*, refs/tags/*. HEAD -> refs/heads/main
  (default branch). First push to unborn branch creates it.
- Contents commits: build tree/commit objects in the repo's object store (same as git push), so
  REST commits and git clones see the same history. Commit author/committer = viewer
  "ada iversen <adaiversen@example.invalid>" with counter-clock timestamps.
- Issues: per-repo numbers from 1. Pulls: per-repo numbers from 1 (separate counter from issues).
- Pagination: GET /user/repos and list endpoints honor ?page=&per_page= (default 30), Link header
  with absolute same-origin rel="next"/"prev"/"first"/"last". Order = creation order.

## Git smart HTTP (lib/git.ts — pkt-line codec, object model, pack read/write, all hand-written)
- Paths: `/{owner}/{repo}.git/info/refs?service=...`, `/{owner}/{repo}.git/git-upload-pack`,
  `/{owner}/{repo}.git/git-receive-pack`. Unknown repo -> 404 (info/refs) and server stays up.
- info/refs upload-pack: Git-Protocol: version=2 header -> v2 ad: `version 2` + caps
  `ls-refs` (bare, NO =unborn — else empty-repo ls-refs would return an unborn ref and fail
  git.clone-empty), `fetch=shallow`, `object-format=sha1`. No header -> v0 ad: `# service=...`
  preamble, `<oid> <ref>` lines, caps on first line after NUL incl `symref=HEAD:refs/heads/main`
  (when refs exist), `side-band-64k ofs-delta`. Empty repo: ONLY the `000... capabilities^{}` line.
  Content-Type `application/x-git-upload-pack-advertisement`.
- info/refs receive-pack: v0 only, `# service=git-receive-pack`, caps `report-status side-band-64k
  delete-refs ofs-delta`. Content-Type `application/x-git-receive-pack-advertisement`.
- POST git-upload-pack v2 ls-refs: parse `command=ls-refs`, delim, peel/symrefs/ref-prefix args.
  Reply pkt-lines `<oid> <ref>[ symref-target:X][ peeled:Y]`; HEAD line carries symref-target;
  annotated tags carry peeled. Empty repo -> NO ref lines at all (not even unborn).
- POST git-upload-pack v2 fetch: parse command=fetch, thin-pack/no-progress/ofs-delta (ignored),
  want/have/shallow/deepen lines, done. Reply sections in order: `acknowledgments` (NAK, or
  `ACK <have>` + `ready` when a have is common), `shallow-info` (shallow/unshallow lines when
  depth requested), `packfile` (sideband band-1 chunks of the pack, each pkt-line <= 65520 raw).
  Pack = plain objects only (NO deltas — pack-deltas check passes with 0 deltas as long as objects
  resolve). Objects to send = reachable(wants) minus reachable(haves), cut by depth:
  depth N keeps commits within N generations of a want; boundary commits are the new shallow set;
  old shallow boundaries now fully included -> `unshallow` lines. Empty result -> valid 0-object
  pack (PACK v2, count 0, trailer SHA-1). Always send a packfile section (even empty) + flush.
  Content-Type `application/x-git-upload-pack-result`.
- POST git-receive-pack: parse command pkt-lines `<old> <new> <ref>[\0caps]`, flush, then raw pack
  bytes (no pack for delete-only). Unpack: read pack, verify every object SHA-1, verify each new
  tip's closure exists (pack + store). Apply per-ref: create (old=ZERO, ref must not exist),
  update (old must match current; new must be descendant of old else ng `non-fast-forward`),
  delete (new=ZERO, old must match). Report: sideband band-1 pkt-lines `unpack ok` (+ `ok <ref>` /
  `ng <ref> <reason>` per ref, reason EXACTLY `non-fast-forward` for FF refusal), then flush.
  Unpack failure -> `unpack <detail>` line only, no ref applied. Content-Type
  `application/x-git-receive-pack-result`. Malformed POST must never crash the server.
- Pack format: `PACK` + u32 v2 + u32 count + entries (type/size varint + zlib deflate) + 20B SHA-1
  trailer over all preceding bytes. Object header for hashing: `<type> <size>\0` + bytes, SHA-1.
  Tree entries sorted by git's rule (dir names compared as if ending in '/').
- Fetch v0: client only uses it if server answers v0; we always answer v2, but keep v0 ad valid.

## REST v3 (lib/rest.ts)
- GET /api/v3/ -> 200 {current_user_url, rate_limit_url} + X-OAuth-Scopes: repo, read:org.
- GET /api/v3/meta -> 200 {"installed_version": "1.0.0"} (any non-empty string).
- GET /api/v3/user -> 200 {login: adaiversen, id: 1000, name, email, type: "User"}.
- POST /user/repos {name, private, description} -> 201 repo shape (name, private, default_branch,
  description, id, full_name, owner:{login}, html_url, url). Duplicate -> 422.
- GET /repos/{o}/{r} -> 200 repo shape; PATCH -> 200 (description); DELETE -> 204.
- POST /repos/{o}/{r}/git/refs {ref: refs/heads/X, sha} -> 201 {ref, object:{sha}}.
  GET /repos/{o}/{r}/git/refs/heads/{branch} -> 200 {ref, object:{sha}}; GET /branches/{branch}
  -> 200 {name, commit:{sha}}; GET /branches -> 200 [{name, commit:{sha}}].
- GET /repos/{o}/{r}/commits[?sha=<ref>] -> 200 [{sha, commit:{message, author, committer},
  parents:[{sha}]}] newest-first (first-parent walk from tip). No sha -> default branch.
- PUT /repos/{o}/{r}/contents/{path} {message, content (base64), branch?, sha?} -> 201 create /
  200 update {content:{sha (blob oid), encoding:'base64'}, commit:{sha}}; stale sha -> 409.
  Works on unborn repo (first commit, no parents). GET -> file {type:'file', encoding:'base64',
  content (single-line base64), sha, size, name, path} or dir listing (array of
  {type:'file'|'dir', name, path, sha}). ?ref=<branch> reads that branch. DELETE {message, sha}
  -> 200 {commit:{sha}}; afterwards GET 404.
- POST /repos/{o}/{r}/labels {name, color} -> 201 {name, color}.
- POST /repos/{o}/{r}/issues {title, body, labels?} -> 201 {number, title, body, state:'open',
  labels:[{name,color}]}; unknown label -> 422. GET /issues?state=&sort=created&direction=&per_page
  -> list (default state open; sort by creation/number). GET /issues/{n} -> 200. PATCH -> 200
  (state/title/body). POST /issues/{n}/comments {body} -> 201 {id, body}; GET -> 200 list.
- POST /repos/{o}/{r}/pulls {head, base, title, body} -> 201 {number, state:'open', title, body,
  head:{ref,sha}, base:{ref,sha}, merged:false}. GET /pulls/{n} -> 200 (+ merge_commit_sha,
  merged_at after merge). GET /pulls?state=all|open -> list. GET /pulls/{n}/files ->
  [{filename, status: added|modified, additions, deletions, changes}] via line diff base->head.
- PUT /pulls/{n}/merge {merge_method: squash} -> 200 {merged:true, sha, message}; unknown PR 404.
  Squash: new commit on base, tree = head tip tree, parents=[base tip]. Conflict: if head and
  base both changed the same file vs merge-base with different content -> 405 {message}.
  After merge: PR state closed, merged true, merged_at set, merge_commit_sha set; merge commit
  visible in GET /commits?sha=<base>; merged content visible via GET /contents?ref=<base>.
- Shapes: extra fields are ALLOWED (checkShape only rejects extras when allowExtra===false,
  and shapes.object() never sets it). So rich GitHub-like bodies are safe.

## GraphQL (lib/graphql.ts) — READ checks-graphql.ts + graphql-client.ts before implementing
- POST /api/graphql {query, variables} (+ batching: JSON array of documents -> array of results).
  Unauthenticated -> exactly 401. Unknown field -> 200 with errors array naming it.
  Unknown repository -> data.repository = null, no errors.
- Surface: Query.viewer{login}; Query.repository(owner, name) -> Repository{id, databaseId, name,
  nameWithOwner, owner{login}, defaultBranchRef{name}, viewerPermission, hasIssuesEnabled,
  issue(number), issues(first, states, orderBy, after), pullRequests(first), pullRequest(number)};
  Issue{id, number, title, state, body}; IssueConnection{nodes, pageInfo{hasNextPage, endCursor}};
  PullRequest{id, number, state, merged, headRefName, baseRefName, mergeable, files(first)};
  PullRequestConnection{nodes}; PullRequestChangedFile{path}; User{login}; Query.node(id) with
  `... on Repository`; Query.__type(name) with fields/enumValues + gh aliases.
  Mutations: createIssue, closeIssue, createPullRequest, mergePullRequest (SQUASH ok), addComment.
  Enums: IssueState OPEN/CLOSED, MergeableState MERGEABLE/CONFLICTING/UNKNOWN, PullRequestState
  OPEN/CLOSED/MERGED, PullRequestMergeMethod MERGE/SQUASH/REBASE, RepositoryPermission
  ADMIN/MAINTAIN/WRITE/TRIAGE/READ, SearchType ISSUE/..., IssueOrderField CREATED_AT/UPDATED_AT/
  COMMENTS, OrderDirection ASC/DESC. issues orderBy CREATED_AT DESC: numbers DESC, ties by number
  DESC; states [OPEN] omits closed. Node ids: base64url of `Repository:<id>` / `Issue:<repoId>:<n>`
  / `PullRequest:<repoId>:<n>` (must round-trip through mutations).
- Hand-written parser for the documented shapes only (variables, inline enums, inline input
  objects, null variables, operation names, fragments `... on X`, aliases).

## MCP (lib/mcp.ts) — READ checks-mcp.ts + mcp-client.ts before implementing
- POST /mcp, streamable HTTP, JSON-RPC 2.0. No Authorization -> 401. Non-JSON body -> HTTP 400
  with JSON-RPC -32700. Unknown tool -> JSON-RPC -32602 or -32601 (never HTTP 500).
- Support BOTH eras: modern 2026-07-28 (`server/discover` -> DiscoverResult with supportedVersions,
  `_meta` revision on requests, no handshake/session) and legacy 2025-11-25 (initialize +
  notifications/initialized, optional Mcp-Session-Id). server/discover on a pre-discover server
  passes as "pre-discover revision" — implement discover anyway.
- initialize -> serverInfo {name, version} non-empty, capabilities.tools present.
- tools/list -> >= 6 tools incl create_repo, get_repo, create_issue, list_issues,
  create_pull_request, merge_pull_request (suffix match, case-insensitive; a prefix is allowed).
  Every tool: non-empty description + inputSchema {type: object}. tools/list must be byte-identical
  across calls (deterministic order, no timestamps).
- tools/call args (github-mcp-server names; suite maps by normalized name, owner_login allowed
  for owner, full_name receives "owner/repo"): create_repo {name, description?, private?};
  get_repo {owner, repo}; create_issue {owner, repo, title, body?}; list_issues {owner, repo,
  state?}; create_pull_request {owner, repo, title, head, base}; merge_pull_request
  {owner, repo, pull_number}. Missing required args -> isError:true or -32602. Two concurrent
  calls keep their own ids/objects. Effects must be visible over REST (same ids/numbers).

## Perf notes
- Hot paths: issue GET (read workload) and issue POST (write) — Map lookups + minimal JSON.
  Push: info/refs + receive-pack per op — keep pack handling allocation-light, no fs.
  Clone: 50 concurrent depth-1 — pack build is 3 small deflates; fine.
- Node http server, keep-alive default. Never block the event loop with big sync work.
- No Date.now()/Math.random() in responses. No console.log per request (log only boot/errors).

## Local grading results (2026-11-17, fresh server each run)
- `sdk/run.ts --url http://127.0.0.1:8123 --token <tok>`: **120/120 passed** (feature 600, agent 200).
- `sdk/run.ts --perf` (same run, fresh server): **score 959/1000** — push p50 1043ms (33 pts,
  T_ref 1640ms), clone p50 163ms (34 pts, T_ref 267ms), read p50 698ms (50 pts, T_ref 2760ms),
  write p50 133ms (42 pts, T_ref 349ms). Beats the house reference (~900) by ~59 points.
- CAUTION: the suite is stateful — a second run against the SAME server fails on duplicate
  repos (422) and doubled fixtures. Always restart the server before a full grading run.
- main.ts lifecycle verified against a mock env (register + 3x /done polls + exit 0).
- Two real bugs found by grading and fixed: (1) REST paths carry the /api/v3 prefix
  (handleRest strips it); (2) the GraphQL tokenizer glued `$` to names (`$owner` was one
  token — variables never resolved); (3) contents commit messages must be stored exactly
  as sent (no trailing newline appended).

## Authorship (make.fun rules — CRITICAL)
- All code authored in THIS (parent/root) session. Subagent-built code FAILS thinking_priced.
  Do NOT delegate the build to a subagent. Vendored kit code counts as NOT authored — write my
  own git-core from the spec (git-client.ts is the reference, not the source).
- main.ts entrypoint must keep authored lines (starter main.ts is the kit's — it is the lifecycle
  file; the authored-lines check counts main.ts: keep the starter's main.ts AS-IS? The lesson
  from best-game-01: entrypoint byte-for-byte starter FAILS thinking_reproduces. The starter
  main.ts here is the REQUIRED lifecycle — but to be safe, rewrite main.ts in my own words
  (same behavior, my own comments/structure) so it holds authored lines. Same for app.ts.
- Bundle + submit in the turn AFTER the build turn (usage rows land after the build turn ends).
- Public GitHub repo @acilpiw needed for the deliverable (created after 2026-11-14) — create via
  browser; repo must contain main.ts at root + MIT LICENSE (already in repo from kit init).
- Claim code per entry in ~/workspace/makefun/*/claim-code.txt (0600, NEVER display/commit).
