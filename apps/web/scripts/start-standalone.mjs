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
import { createServer as createHttpServer, request } from 'node:http';
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
/**
 * A mail sink, and the reason it exists rather than a `noop` driver.
 *
 * The suite runs with `NODE_ENV=production`, and the configuration layer
 * refuses both `noop` and `smtp` there — a driver that silently sends nothing
 * is exactly the production fault it is meant to prevent. Pointing the real
 * Resend adapter at a local sink satisfies that rule honestly: registration
 * builds the request, sets its tags and handles the response through the same
 * code path a customer's verification email will take.
 *
 * It accepts anything and answers as the provider does. Assertions about what
 * an email may contain live in `packages/infra/src/mail/mail.test.ts`, where
 * they can be precise; this only has to exist.
 */
const mailPort = publicPort + 2;

/**
 * An object-store sink, on the same principle as the mail sink above.
 *
 * The upload is a three-stage flow whose middle stage is a `PUT` from the
 * **browser straight to the bucket** (docs/10 §4). Without somewhere for that
 * `PUT` to land, the media journey cannot be tested at all — which is how it
 * stayed untested until docs/23 found it.
 *
 * What this substitutes is precisely and only the bucket. Everything that is
 * *ours* runs for real: `S3StorageProvider` composes and signs the URL, the
 * browser `PUT`s to it with the signed headers, `completeUpload` `HEAD`s the
 * object and compares the true size against the signed ceiling, the job goes
 * onto a real BullMQ queue, and `apps/worker` decodes the bytes and writes the
 * derivatives back. A substituted *provider* would have skipped all of that;
 * a substituted *bucket* skips none of it.
 *
 * It does not verify the signature. Verifying SigV4 here would be
 * re-implementing the thing under test and asserting our own arithmetic
 * against itself — the signature is covered where it can be covered honestly,
 * in `packages/infra/src/storage/storage-provider.contract.test.ts`.
 *
 * **This is not evidence that Cloudflare R2 works.** R2 is verified against R2
 * or not at all; that belongs to the deployment gate, and nothing here may be
 * read as having done it.
 */
const storagePort = publicPort + 3;
/** Key → {bytes, contentType}. Per run, in memory; the process is the lifetime. */
const objects = new Map();

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
    /**
     * Media is served **through the TLS terminator**, and it has to be.
     *
     * The renderer refuses any media URL that is not `https:`
     * (`safeMediaUrl`) — a deliberate rule, and the same one the public page's
     * CSP encodes for `cdn.zfaf.app`. Serving the sink on plain HTTP therefore
     * produced a published page with the photograph silently dropped: correct
     * behaviour, invisible failure.
     *
     * So `STORAGE_PUBLIC_BASE_URL` points here rather than at the sink's own
     * port, which is also the production arrangement: the bucket's public face
     * is a TLS hostname in front of it, never the bucket's raw address.
     *
     * The *signed upload* endpoint stays plain HTTP on the sink's own port.
     * That is not mixed content: browsers treat `127.0.0.1` as a potentially
     * trustworthy origin whatever the scheme.
     */
    if ((incoming.url ?? '').startsWith('/zfaf-media/')) {
      const media = request(
        {
          host: '127.0.0.1',
          port: storagePort,
          path: incoming.url,
          method: incoming.method,
          headers: { ...incoming.headers, host: `127.0.0.1:${storagePort}` },
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        },
      );
      media.on('error', () => {
        outgoing.writeHead(502);
        outgoing.end('storage unavailable');
      });
      incoming.pipe(media);
      return;
    }

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
          /**
           * The client address, set **here** when the browser did not send one.
           *
           * Most suites give themselves a distinct address through Playwright's
           * `extraHTTPHeaders`, so that a per-IP rate limit belonging to one
           * file is not spent by another. That works because those suites only
           * ever talk to us.
           *
           * It breaks the moment a page makes a **cross-origin** request: the
           * browser attaches every extra header to the upload `PUT` as well,
           * lists `x-forwarded-for` in the preflight's
           * `Access-Control-Request-Headers`, and the bucket — correctly —
           * refuses a header its CORS policy does not name. The upload then
           * fails with `net::ERR_FAILED` for a reason that has nothing to do
           * with the product.
           *
           * So a suite that uploads sets `E2E_CLIENT_ADDRESS` instead and sends
           * no header of its own. This is also the more faithful arrangement:
           * in production the application never trusts a browser-supplied
           * `x-forwarded-for` — the load balancer writes it, exactly as here.
           */
          ...(incoming.headers['x-forwarded-for'] || !process.env.E2E_CLIENT_ADDRESS
            ? {}
            : { 'x-forwarded-for': process.env.E2E_CLIENT_ADDRESS }),
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

const mailSink = createHttpServer((incoming, outgoing) => {
  // Drained rather than read: an unconsumed request body keeps the socket open
  // and the adapter's own timeout would then be what ends the test.
  incoming.resume();
  incoming.on('end', () => {
    outgoing.writeHead(200, { 'content-type': 'application/json' });
    outgoing.end(JSON.stringify({ id: 'e2e-mail-sink' }));
  });
});
mailSink.listen(mailPort, '127.0.0.1');

/**
 * The bucket. Path-style, because the harness sets `STORAGE_DRIVER=minio`,
 * which is what makes the adapter address `host/bucket/key` rather than
 * `bucket.host/key` — a virtual-host bucket needs DNS this machine does not
 * have.
 */
const storageSink = createHttpServer((incoming, outgoing) => {
  const url = new URL(incoming.url ?? '/', `http://127.0.0.1:${storagePort}`);
  // `/{bucket}/{key…}` — the leading segment is the bucket, the rest the key.
  const key = decodeURIComponent(url.pathname.replace(/^\/[^/]+\//, ''));

  /**
   * CORS, because the upload is cross-origin by design.
   *
   * The browser `PUT`s to the bucket's hostname, not ours, and a `PUT` with a
   * `Content-Type` is never a simple request — so the browser sends an
   * `OPTIONS` preflight first and refuses the upload outright if the answer
   * does not name our origin and the headers the signature bound in.
   *
   * A sink without this is not a faithful bucket, and the difference is not
   * academic: **a real bucket with no CORS policy fails exactly the same way**,
   * with `net::ERR_FAILED` and nothing in any server log. That is what this
   * suite found on its first run, and it is why docs/22 now lists the R2 CORS
   * policy as a deployment step rather than leaving it to be discovered by the
   * first customer who tries to add a photograph.
   */
  const origin = incoming.headers.origin;
  if (origin) {
    outgoing.setHeader('access-control-allow-origin', origin);
    outgoing.setHeader('vary', 'origin');
  }

  if (incoming.method === 'OPTIONS') {
    outgoing.writeHead(204, {
      'access-control-allow-methods': 'GET, HEAD, PUT, DELETE',
      // The two the presigner signs, plus what the SDK may add.
      'access-control-allow-headers': 'content-type, content-length, x-amz-content-sha256',
      'access-control-max-age': '600',
    });
    outgoing.end();
    return;
  }

  if (incoming.method === 'PUT') {
    const chunks = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => {
      objects.set(key, {
        bytes: Buffer.concat(chunks),
        contentType: incoming.headers['content-type'] ?? 'application/octet-stream',
      });
      outgoing.writeHead(200, { etag: '"e2e"' });
      outgoing.end();
    });
    return;
  }

  const object = objects.get(key);
  if (!object) {
    // 404 rather than an empty 200: `completeUpload` distinguishes "the upload
    // never arrived" from "it arrived empty", and a sink that blurred the two
    // would hide exactly the case that check exists for.
    outgoing.writeHead(404);
    outgoing.end();
    return;
  }

  if (incoming.method === 'HEAD') {
    outgoing.writeHead(200, {
      'content-length': String(object.bytes.byteLength),
      'content-type': object.contentType,
    });
    outgoing.end();
    return;
  }

  if (incoming.method === 'DELETE') {
    objects.delete(key);
    outgoing.writeHead(204);
    outgoing.end();
    return;
  }

  outgoing.writeHead(200, {
    'content-length': String(object.bytes.byteLength),
    'content-type': object.contentType,
  });
  outgoing.end(object.bytes);
});
storageSink.listen(storagePort, '127.0.0.1');

/**
 * The media worker, started only when the harness asks for it.
 *
 * Off by default: most suites never upload, and a second process consuming a
 * shared Redis queue is a cost they should not pay. The journey suite sets
 * `E2E_START_WORKER=1`, because an upload that is never processed never becomes
 * a photograph — the document only takes a URL once the worker reports `ready`.
 *
 * `node --import tsx src/index.ts` — the **same command the worker image
 * runs** (`infra/docker/worker.Dockerfile`), not `dist/`. `@zfaf/core` exports
 * TypeScript source rather than a build, so compiled worker output cannot
 * resolve it at runtime; running the built output here would have been testing
 * a startup path production does not use, and it fails immediately with
 * `ERR_MODULE_NOT_FOUND` — which is how this was found.
 */
const workerRoot = join(webRoot, '..', 'worker');
const worker =
  process.env.E2E_START_WORKER === '1'
    ? spawn(process.execPath, ['--import', 'tsx', join(workerRoot, 'src', 'index.ts')], {
        stdio: 'inherit',
        cwd: workerRoot,
        env: { ...process.env, SERVICE_NAME: 'worker-e2e' },
      })
    : null;

const shutdown = () => {
  worker?.kill('SIGTERM');
  storageSink.close();
  mailSink.close();
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
  mailSink.close();
  proxy.close();
  process.exit(code ?? 0);
});
