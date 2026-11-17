// main.ts — the entry point: how this process lives inside the trial environment.
//
// The environment (env) runs the suite against this server, and it only knows where the
// server is once the server tells it. The dance is:
//
//   1. MAKEFUN_ENV_URL names the env's origin. Without it there is nothing to register
//      with, so the process gives up immediately.
//   2. The server binds an ephemeral port (the kernel picks one; never 8080, the env
//      owns that). The port is reported to the env, which then dials the server there.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. A 200 registers us; a 409 means some
//      other entry already registered first, which is fine — we still wait like any other
//      entry. 400/405 are contract errors and end the process; anything else is retried,
//      because the env may still be starting up.
//   4. GET $MAKEFUN_ENV_URL/done, over and over, until it answers {"done": true}. The
//      env answers each poll at once, so this is a poll loop, not a held request. A failed
//      or slow poll is retried with a short backoff; the process never leaves before the
//      env says the trial is over.
//   5. Close the server and exit 0. The harness then stops the env, which writes the
//      export the scorer reads.
//
// The lifecycle is the harness's contract, so its behaviour is kept exact; the server
// itself lives in app.ts.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** A single register/done request is abandoned after this long and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first gap between retries, and the longest it ever grows to. */
const RETRY_FIRST_MS = 250;
const RETRY_CAP_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The gap after `failures` failed attempts: doubling from RETRY_FIRST_MS, capped. */
function backoffMs(failures: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** Math.min(failures, 8));
}

/** Register the bound port with the env; returns once the env has accepted it (or a 409). */
async function registerPort(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
      // A network error or a timeout: the env may still be starting, so retry below.
    }
    await sleep(backoffMs(failures));
  }
}

/** Poll the env until it says the trial is done; never return earlier. */
async function waitUntilDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, poll again.
    }
    await sleep(backoffMs(failures));
  }
}

/** Bind, register, wait for done, shut down: the whole life of the process. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await registerPort(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
