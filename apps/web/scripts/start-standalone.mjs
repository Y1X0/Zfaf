/**
 * Starts the production server for end-to-end tests, behind HTTPS.
 *
 * Two decisions, both to keep the tests honest:
 *
 *   • **The standalone server, not `next start`.** Standalone is what we
 *     deploy, `next start` refuses to run against it, and a development server
 *     behaves differently enough under server components and bundling that
 *     testing it would prove the wrong thing. Next does not copy static assets
 *     into the standalone tree, so this does that first.
 *
 *   • **TLS in front.** The session cookie is `__Host-` prefixed (ADR-0006),
 *     and browsers refuse to accept that prefix over plain HTTP. Serving the
 *     tests over HTTP would have meant weakening the cookie for tests — so the
 *     tests would no longer exercise the cookie production uses. A self-signed
 *     certificate and one proxy hop is a much smaller price.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:https';
import { request } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const standalone = join(webRoot, '.next', 'standalone', 'apps', 'web');

if (!existsSync(join(standalone, 'server.js'))) {
  console.error('No standalone build found. Run `pnpm build` first.');
  process.exit(1);
}

mkdirSync(join(standalone, '.next'), { recursive: true });
cpSync(join(webRoot, '.next', 'static'), join(standalone, '.next', 'static'), { recursive: true });
if (existsSync(join(webRoot, 'public'))) {
  cpSync(join(webRoot, 'public'), join(standalone, 'public'), { recursive: true });
}

const publicPort = Number(process.env.PORT ?? 3100);
// The Next server listens here; only the TLS terminator is reachable.
const upstreamPort = publicPort + 1;

const certDir = join(tmpdir(), 'zfaf-e2e-tls');
mkdirSync(certDir, { recursive: true });
const keyPath = join(certDir, 'key.pem');
const certPath = join(certDir, 'cert.pem');

if (!existsSync(keyPath) || !existsSync(certPath)) {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '2',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ],
    { stdio: 'ignore' },
  );
}

/**
 * `HOSTNAME=localhost`, and it is load-bearing rather than cosmetic.
 *
 * Next builds the URL it hands to middleware from `fetchHostname ||
 * 'localhost'`, and separately builds `initURL` — the base it compares a
 * middleware rewrite against — from the configured hostname. When the two
 * differ, `parseRelativeURL` sees two origins, marks the rewrite **external**,
 * and Next re-requests it over the network instead of rendering it in place.
 *
 * Bound to `127.0.0.1` the two disagree (`127.0.0.1` vs `localhost`), so every
 * locale rewrite became an outbound request — which, with `x-forwarded-proto:
 * https` set by the terminator below, meant Next trying to speak TLS to its own
 * plain-HTTP port. That surfaced as `EPROTO` behind TLS and as a 307 loop over
 * plain HTTP, and it is why `/` was unreachable while `/en` worked.
 *
 * Naming the host `localhost` makes both identities the same string, the
 * rewrite resolves as relative, and it is handled internally with no network
 * hop at all. `localhost` still binds loopback, so nothing outside this machine
 * can reach the upstream — only the TLS terminator can.
 */
const child = spawn(process.execPath, [join(standalone, 'server.js')], {
  stdio: 'inherit',
  env: { ...process.env, PORT: String(upstreamPort), HOSTNAME: 'localhost' },
});

const proxy = createServer(
  { key: readFileSync(keyPath), cert: readFileSync(certPath) },
  (incoming, outgoing) => {
    const upstream = request(
      {
        host: '127.0.0.1',
        port: upstreamPort,
        path: incoming.url,
        method: incoming.method,
        /**
         * The forwarded pair, and it has to be a pair.
         *
         * `x-forwarded-proto` tells the app it is behind TLS. On its own it
         * makes Next build request URLs as `https://` against the *upstream's*
         * own address — a plain-HTTP port — so any middleware rewrite becomes
         * an "external" destination that Next then tries to reach over TLS,
         * and the handshake fails with a protocol error. Sending the public
         * host alongside it keeps the app's idea of its own origin equal to
         * the one the browser used, which is what a real load balancer does
         * and what makes an internal rewrite stay internal.
         */
        /**
         * The upstream is addressed by the name it knows itself by.
         *
         * `host` is rewritten to `localhost:<upstream>` deliberately: Next
         * compares a middleware rewrite's origin against a base built from its
         * own hostname, and a mismatch turns an internal rewrite into an
         * outbound request. The public origin the application should print in
         * links comes from `PUBLIC_BASE_URL`, not from this header — which is
         * why M6 made `baseUrl()` prefer configuration over the request.
         *
         * `x-forwarded-proto` still tells the app it is behind TLS, so the
         * `Secure` session cookie it sets is consistent with the connection the
         * browser actually made.
         */
        headers: {
          ...incoming.headers,
          host: `localhost:${upstreamPort}`,
          'x-forwarded-proto': 'https',
          'x-forwarded-host': `127.0.0.1:${publicPort}`,
        },
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );

    upstream.on('error', () => {
      outgoing.writeHead(502);
      outgoing.end('upstream unavailable');
    });
    incoming.pipe(upstream);
  },
);

proxy.listen(publicPort, '127.0.0.1');

const shutdown = () => {
  proxy.close();
  child.kill('SIGTERM');
  try {
    rmSync(certDir, { recursive: true, force: true });
  } catch {
    // Nothing useful to do if the temporary directory is already gone.
  }
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
child.on('exit', (code) => {
  proxy.close();
  process.exit(code ?? 0);
});
