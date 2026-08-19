// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
// A single failed/slow request used to mean an object silently never appeared —
// no retry, just a console.error. Retries a couple of times before giving up.

export async function fetchWithRetry(url: string, attempts = 3, delayMs = 400): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs * (i + 1)));
  }
  throw lastErr;
}
