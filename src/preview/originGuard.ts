// Who is allowed to talk to the preview server.
//
// Binding to 127.0.0.1 keeps other machines out. It does NOT keep out the
// user's own browser, and that is the whole problem: any web page they happen to
// visit can reach this server, because localhost is reachable from every origin.
//
// Nothing clever is required to exploit that. A cross-origin POST carrying a
// text/plain body is a CORS *simple* request: no preflight, so the browser
// delivers it and the server acts on it, and the sender never needs to read the
// reply. That reaches every mutating endpoint here — the file-system ops, the
// upload path and the checkpoint restore — each of which writes or deletes
// inside the user's paper. Reading is reachable too, via DNS rebinding, which
// makes an attacker-controlled name same-origin with this server.
//
// Three checks, each closing a different door. Removing any one of them
// reopens it; test/originGuard.test.ts fails loudly if you do.

import type { IncomingMessage } from 'node:http';

/** Methods that change something. GETs are covered by the Host check alone. */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const loopbackHosts = (port: number) =>
  new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

/**
 * Why this request should be refused, or null to allow it.
 *
 * Returning a reason rather than a boolean so the 403 can say which rule fired —
 * a silent refusal here would be indistinguishable from the server being broken.
 */
export function refuseReason(req: IncomingMessage, port: number): string | null {
  const allowed = loopbackHosts(port);

  // 1. The Host header must name a loopback address on our port.
  //
  // This is what stops DNS rebinding. An attacker points evil.com at 127.0.0.1,
  // waits for the browser to re-resolve, and then their page is *same-origin*
  // with us — every check below passes, and GETs like /api/file and /export.zip
  // become straightforward exfiltration of the user's project. But the browser
  // still sends `Host: evil.com`, because that is the name in the URL.
  const host = (req.headers.host ?? '').toLowerCase();
  if (!allowed.has(host)) {
    return `unexpected Host header "${req.headers.host ?? ''}" — expected a loopback address on port ${port}`;
  }

  // 2. Sec-Fetch-Site, where the browser sends it (all current ones do).
  //
  // `same-origin` is our own page; `none` is a user-typed URL or a bookmark.
  // Anything else — `cross-site`, `same-site` — is a page we did not serve.
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    return `cross-site request (Sec-Fetch-Site: ${site})`;
  }

  // 3. Origin, on anything that changes state.
  //
  // Browsers set Origin on every non-GET/HEAD request, same-origin included, so
  // requiring it costs our own page nothing and refuses a cross-origin POST even
  // on a browser too old for Sec-Fetch-Site. It does mean a non-browser client
  // (curl, a script) must send Origin to mutate — deliberate: the only HTTP
  // clients here are the workspace page and the legacy viewer.
  if (MUTATING.has((req.method ?? '').toUpperCase())) {
    const origin = req.headers.origin;
    if (!origin) return 'missing Origin on a state-changing request';
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return `unparseable Origin "${origin}"`;
    }
    if (!allowed.has(originHost)) return `cross-origin request from "${origin}"`;
  }

  return null;
}

/**
 * Whether a WebSocket handshake may proceed.
 *
 * WebSocket handshakes are exempt from the same-origin policy, so any page can
 * open one. Two consequences worth closing: a successful connect confirms which
 * port TeXChronicle is on, turning a blind 64k-port spray into a targeted one; and
 * the server immediately pushes a `reload` frame naming the user's main file,
 * then narrates their compiles and errors in real time.
 */
export function allowWebSocket(origin: string | undefined, port: number): boolean {
  // A non-browser client (our own smokes, a CLI) sends no Origin at all. It also
  // cannot be a hostile web page, which is what this is defending against.
  if (!origin) return true;
  try {
    return loopbackHosts(port).has(new URL(origin).host.toLowerCase());
  } catch {
    return false;
  }
}
