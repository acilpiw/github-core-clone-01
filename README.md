# Forge — a GitHub-compatible git forge in one Node process

[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/acilpiw/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/acilpiw/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

An entry for [the contest](https://make.fun/bounty/github-core-clone-01): a standalone,
GitHub-compatible git forge that serves clone, push, issues, pull requests, GraphQL and MCP
from one process, with no UI, no dependencies, no git binary and no outside service.

## What it serves

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (protocol v2 and v0), `git-receive-pack` (v0) |
| anything else | 404 `{"message":"Not Found"}` |

Everything is served from an in-memory store. Object storage is a hand-written SHA-1
object model (blobs, trees, commits, tags) with pack writing and reading, including
OFS and REF deltas, so a real `git clone` and `git push` work against it. The clock is
deterministic (one second per call from a fixed epoch), so two runs of the same
operations produce the same export.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types
on its own; the flag is harmless there and makes an older local Node work too. There is
nothing to install: the program imports `node:http`, `node:zlib`, `node:crypto` and its
own modules only, and the trial has no package manager and no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as
   JSON. The env records the address the request came from plus that port as your base URL.
   The first register wins.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while
   the suite runs and `{"done":true}` once its export is written. Poll it with a short
   backoff; never hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL`
is unset there is nothing to talk to, so `main.ts` exits 1 at once.

## Layout

- `main.ts`: the lifecycle above.
- `app.ts`: the HTTP server — routing, auth, body handling.
- `lib/git.ts`: pkt-line codec, SHA-1 objects, pack read/write, reachability.
- `lib/store.ts`: the in-memory forge store — repos, refs, issues, pull requests, files.
- `lib/git-http.ts`: smart HTTP — `info/refs`, upload-pack (v2 and v0), receive-pack.
- `lib/rest.ts`: the REST v3 API.
- `lib/graphql.ts`: a hand-written GraphQL parser and the v4 API.
- `lib/mcp.ts`: the MCP endpoint over streamable HTTP.
- `DESIGN.md`: the architecture and wire-level design notes.

## Local grading

Graded locally against the kit's sealed suite (`sdk/run.ts`) on a fresh server:

- **120/120 conformance checks passed** (feature 600, agent 200)
- **perf 159/200** — push p50 1043ms, clone p50 163ms, read p50 698ms, write p50 133ms
- **score 959/1000**

The suite is stateful, so each grading run needs a fresh server: restart the forge
before every run.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service
you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach.
The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

This entry is MIT licensed.
