# Shifter Web Proxy

A web proxy that combines **Scramjet in the browser**, **HAProxy (local TCP or HTTPS/WSS termination)**, **Rust Wisp gateways**, **Redis session enforcement**, and **Shifter residential proxies**.

Visitors enter a website, choose an exit country, and browse inside the page without configuring their browser’s proxy settings. Each visitor receives a server-generated sticky session ID. The gateway adds the upstream credentials and country targeting on the server.

**Status: shared browser SDK and server-verified reCAPTCHA v2 implemented.** The hosted entry point is `/sdk/v1/shifter-web-proxy.js`, exposing `ShifterWebProxy.create()`. Production API access uses site-bound anonymous bearer credentials; the legacy cookie API exists only in synthetic test mode. Production activation still requires real CAPTCHA credentials and final acceptance on both websites. This does not establish a unique-person identity or universal destination compatibility.

An offline HTML version of this README is included at [docs/readme.html](docs/readme.html).

## Contents

- [What is included](#what-is-included)
- [Shared SDK integration](#shared-sdk-integration)
- [Architecture](#architecture)
- [Repository and secret policy](#repository-and-secret-policy)
- [Requirements](#requirements)
- [Quick start with synthetic traffic](#quick-start-with-synthetic-traffic)
- [Using a real Shifter account](#using-a-real-shifter-account)
- [HTTPS/WSS deployment](#httpswss-deployment)
- [Configuration reference](#configuration-reference)
- [Redis security rules](#redis-security-rules)
- [Session lifecycle and limits](#session-lifecycle-and-limits)
- [Browser integration and isolation](#browser-integration-and-isolation)
- [API reference](#api-reference)
- [Gateway forwarding and destination policy](#gateway-forwarding-and-destination-policy)
- [HAProxy, regions, and recovery](#haproxy-regions-and-recovery)
- [Testing and validation](#testing-and-validation)
- [Operations and troubleshooting](#operations-and-troubleshooting)
- [Project layout](#project-layout)
- [Dependencies and reproducibility](#dependencies-and-reproducibility)
- [Production work still required](#production-work-still-required)

## What is included

- Trusted browsing controls: destination input, country selector, Browse, Back, Forward, Reload, Stop, remaining time, remaining bytes, and status messages.
- An embedded Scramjet runtime using bare-mux and Epoxy transport.
- Two Rust gateway replicas, a Rust session API, Redis, and an HAProxy connection balancer.
- Country selection and a cryptographically random 128-bit SID per browsing assignment.
- Shared time/byte allowances, single-use transport tickets, one active connection per visitor, stream admission limits, revocation, and expiry.
- An authenticated SOCKS5 connector that sends every destination stream through a configured Shifter regional endpoint.
- Synthetic destination/login fixtures, integration checks, outage tests, and a 1,000-session load test.
- Explicit, bounded live smoke tests for country targeting, sampled sticky IP behavior, and TLS forwarding.
- Example configuration files and a bootstrap script that creates ignored local copies.

The SDK includes reCAPTCHA v2; live use requires configured credentials. Fingerprint identity is not part of this integration.

## Web proxy page example

`web/control/index.html` retains the Shifter landing page and browser toolbar. Its `app.js` is a UI adapter: it consumes SDK state and invokes methods; API calls, CAPTCHA, runtime messages, polling, expiry, and cleanup live in the SDK. `web/control/minimal.html` demonstrates a different interface using the same library.

Search validates the address and opens the library-owned reCAPTCHA v2 modal. Closing it or pressing Escape cancels. A successful challenge is verified by the API before browsing starts. Navigation, reload, and location changes within an active session do not require another challenge. Every landing-page Search does. Failed or unavailable CAPTCHA never grants access.

The browser retains Back, Forward, Reload, country selection, the URL field, time/data allowance, End session, return-to-home, and resume controls. The website owns these visuals and the loading overlay. The SDK owns the destination iframe and emits state for the website to render.

## Shared SDK integration

Initially only `https://example.com` and `https://second.example.com` are allowed in production. No `www`, HTTP, wildcard, or other subdomain is implicitly included. Loading the public JavaScript does not grant authorization; API and runtime origins are checked separately.

```html
<div id="proxy-view" style="height:70vh"></div>
<script src="https://proxy.example.net/sdk/v1/shifter-web-proxy.js"></script>
<script>
const proxy = ShifterWebProxy.create({
  container: document.querySelector('#proxy-view')
});
proxy.subscribe(state => {
  // Render your controls using state.active, busy, loading, countries,
  // country, url, session, remainingSeconds, persistent and error.
});
proxy.init().then(() => {
  // Enable your Search control. Call from its submit handler:
  // proxy.search({url: address.value, country: country.value});
}).catch(error => console.error(error.message));
</script>
```

`create()` returns immediately; `init()` waits for the selected release and configuration. Methods return promises. `subscribe(callback)` invokes the callback immediately and returns an unsubscribe function. `getState()` returns a defensive copy. One instance may own a container at a time.

| Method | Contract |
| --- | --- |
| `init()` | Fetch allowed-site configuration and restore available allowance; does not start browsing |
| `search({url, country})` | Validate, display CAPTCHA, authorize, and browse; rejects with `CANCELLED` on dismissal |
| `navigate(url)` | Navigate an active session without another CAPTCHA |
| `back()`, `forward()` | Traverse destination history |
| `reload()` | Reconnect with the same assignment/allowance after lease release |
| `changeCountry(country)` | Revoke old assignment, clear website state, preserve allowance, and navigate |
| `stop()` | Revoke access and await runtime cleanup; retain anonymous identity |
| `destroy()` | Abort SDK work, detach iframe/listeners/timers, and release the container; does not reset server allowance |
| `subscribe(callback)`, `getState()` | Read UI state without exposing credentials or tickets |

State status is `idle`, `initializing`, `ready`, `verifying`, `connecting`, `browsing`, `interrupted`, `stopped`, `expired`, `exhausted`, or `destroyed`. Errors contain `code` and `message`. Handle rejected promises; only `CANCELLED` normally needs no error message. Concurrent operations reject with `BUSY`. A storage-disabled browser uses memory and reports `persistent: false`.

The default API origin is the loader's origin. `apiOrigin` is an optional local-integration override. `nonce` can be supplied for CSP-authorized injected scripts/styles; the loader inherits its script nonce by default. Neither option changes server authorization.

### Automatic connection recovery

SDK 1.0.3 silently retries a failed GET document navigation at most twice, keeping `loading: true` and the website's branded overlay visible. Backoffs are 300 and 600 milliseconds; each reconnect waits 6.5 seconds for the previous gateway lease to retire before requesting a fresh one-use ticket. Stop, a new SDK operation, destruction, or expiry cancels queued recovery. After the retry budget is exhausted, the SDK sets `status: interrupted`, releases the overlay, and leaves browser controls available without displaying a connection-error banner.

A thrown WebSocket connection failure reconnects with the existing SID. A transient SOCKS connection failure can rotate the SID only when the active gateway has recorded that failure for the requested hostname and session revision. Rotation preserves country, region, expiry, used bytes, and byte limit. The atomic Redis operation rejects stale/concurrent recovery, inactive sessions, and more than two recoveries in a 30-second window. The old lease is never cleared early. Redis failures deny recovery.

Website HTTP errors, CAPTCHAs, and login pages are normal responses and pass through unchanged. Failed POST/PUT submissions, engine errors, destination policy/DNS rejection, explicit upstream authentication rejection, and exhausted/expired authorization are not automatically replayed. Recovery applies to failed document loads, not arbitrary background requests or embedded widgets. Changing a residential SID may affect a destination's IP-bound login or session.

The runtime replaces failed document responses with a neutral placeholder before they reach the screen. A short-lived, one-use capability held by the service worker lets the trusted runtime retrieve the actual request method and failure classification; destination HTML and untrusted window messages cannot manufacture that classification. Existing SDK releases receive a friendly error, while 1.0.2 negotiates automatic recovery over the existing v1 protocol. Reloading a website using the stable hosted SDK loader picks up the update after deployment; site adapters render `state.loading` directly, without a second loading timeout that could reveal a recovery in progress.

SDK 1.0.3 retries API reads and ticket issuance up to twice (500/1000 ms backoff) on network failures or unstructured gateway 502/503/504 responses. Failed background session checks stay silent, preserve the destination and SID, and back off up to 30 seconds; the local expiry clock keeps running. Explicit authorization, quota, and storage refusals are not treated as transient gateway failures. Mutating session requests and destination form submissions are not blindly replayed. Slow-page timeouts release the overlay without a warning banner.

The runtime routes Scramjet v1's injected WASM script through the engine's JavaScript wrapper; raw WASM fetches and reset assets still bypass engine configuration. On browsers without transferable request streams, the service worker buffers request bodies up to 8 MiB before the first BareMux send, preserving method, headers and bytes. Larger buffered uploads fail before sending. Capable browsers keep streaming. This addresses a reproducible request-stream compatibility gap; it does not guarantee that Google will accept a proxy IP or that every CAPTCHA works. A destination CAPTCHA remains on its existing SID and is never used as a reason to rotate an IP automatically.

### CAPTCHA configuration

Register both production website domains and the explicitly enabled staging hostname `staging.example.com` on the existing standard v2 checkbox key. The **site key is public**, including in GitHub. The **secret is private** and must never enter SDK code, HTML, URLs, repository files, or logs. Set `RECAPTCHA_SITE_KEY` and mount `RECAPTCHA_SECRET_FILE` only in the API container. The API needs outbound HTTPS to Google's fixed SiteVerify endpoint. Google responses must be successful, free of error codes, and match the exact caller hostname. Google enforces the response token's two-minute lifetime; the returned challenge timestamp is validated as a load timestamp, not mistaken for when the user solved it. A SHA-256 token reservation in Redis rejects concurrent replay; raw CAPTCHA responses are not stored. See [Google verification](https://developers.google.com/recaptcha/docs/verify).

For local real-CAPTCHA development, add `compose.captcha.example.yaml` as an overlay, set the public key and local secret-file path in ignored configuration, and register localhost on a development key. The overlay mounts the secret only in the API. Synthetic browser tests instead use the disposable test stack; Google test tokens are not automatically accepted by its Redis-backed mock verifier.

If Google reports a widget error, the SDK keeps its frame and modal open so Google's own message remains visible, and offers Try again or Close. It does not reset/remove the frame automatically on that error: doing so hides domain/key errors and produces misleading canceled network requests. Only a completed challenge can call the session API. Script-load failures and expired challenges also offer an explicit retry. For a localhost rejection, verify that the exact site key returned by the local API is the key whose domain settings you saved in Google; changing another key does not affect the running demo.

Production startup rejects missing credentials and Google's public test credentials. Synthetic tests seed random one-use challenge hashes in private Redis; those records are read only in `APP_ENV=test`. There is no configurable production verifier URL or bypass switch.

### Release and rollback

Maintain source only under `web/sdk/src/`. `node scripts/build-sdk.mjs 1.0.3` creates/verifies immutable files and a SHA-256 manifest in `web/sdk/releases/1.0.3/`. With no argument, the script verifies the release selected by the loader. It rejects changed content for an existing version. To release an update, pass a new semantic version and change `RELEASE` in `web/sdk/v1/shifter-web-proxy.js` after validating that release.

The loader uses `Cache-Control: public, no-cache`; release assets use a one-year immutable cache. Each page imports one fixed release. Rollback changes the loader's release target; existing page instances keep their release until reloaded. Retain old release directories. v1 releases must preserve protocol 1 so the runtime supports the current and previous SDK release; introduce `/sdk/v2/` for a breaking contract. Release 1.0.3 adds silent status-check retries and removes connection/slow-page notices. The accompanying runtime fixes injected WASM routing and unsupported request-stream transfers. Release 1.0.2 adds bounded proxy recovery. Releases 1.0.1 (CAPTCHA error-frame handling) and 1.0.0 remain available for rollback.

Deploy the API and assets before changing website adapters, and disable the old production session creation at that cutover. Old cookie sessions are not imported: visitors complete a fresh CAPTCHA for a new origin-scoped identity. Update Redis ACLs before deploying; missing permissions fail closed.

## Architecture

```text
Visitor browser
  |
  +-- http://localhost:8080
  |      HAProxy TCP listener
  |          -> Rust API / trusted browsing controls
  |          -> Redis: identity-linked daily allowance and tickets
  |
  +-- http://localhost:8081
         HAProxy TCP listener / leastconn
             -> Rust gateway A or B
                 |-- serves Scramjet, bare-mux, Epoxy, and service worker
                 |-- redeems Wisp ticket and claims connection ownership
                 |-- validates destination and reserves destination bytes
                 |
                 +-- authenticated SOCKS5 -> blr.p.shifter.io:443
                                                -> residential exit
                                                -> destination website
```

Scramjet rewrites proxied website behavior in the visitor’s browser. Wisp carries multiplexed destination TCP streams over a WebSocket. The Rust gateway provides the session-specific upstream connector; Scramjet does not receive the residential proxy credentials.

The same Rust binary has two roles:

| Role | Responsibility | Secret access |
| --- | --- | --- |
| `api` | Trusted controls, country list, session lifecycle, ticket issuance | Does not load the upstream credential file |
| `gateway` | Runtime assets, authenticated Wisp, DNS/destination checks, SOCKS forwarding | Reads the mounted upstream credential file |

Redis is shared across the API and gateway replicas. No process-global proxy URL is changed when a visitor selects a country. Upstream authenticated connections are not pooled across visitors.

## Repository and secret policy

**Only portable examples of deployment and credential configuration belong in this repository.** Real accounts, passwords, machine paths, resolved configuration, operational logs, session records, live IP evidence, and local validation reports remain outside Git.

| Tracked example | Generated local file | Purpose |
| --- | --- | --- |
| `compose.example.yaml` | `compose.yaml` | Local development topology |
| `compose.test.example.yaml` | `compose.test.yaml` | Synthetic upstream and isolated test database |
| `compose.production.example.yaml` | `compose.production.yaml` | HTTPS ingress and applications connected to existing private Redis |
| `deploy/haproxy.production.example.cfg` | `deploy/haproxy.production.cfg` | TLS certificates, HTTPS routing, redirects and WSS |
| `deploy/production.example.env` | `.env.production` | Hostnames and private certificate/secret paths |
| `deploy/haproxy.example.cfg` | `deploy/haproxy.cfg` | TCP listeners, balancing, DNS resolution, health checks |
| `.env.example` | `.env` | Non-secret mock defaults; local credential-file path for live mode |
| `tests/fixtures/credentials.example.toml` | `tests/fixtures/credentials.toml` | Public synthetic values accepted only by the mock fixture |
| `examples/shifter-credentials.example.toml` | A file under `.secrets/` or outside the checkout | Placeholder schema for a real upstream account |

The synthetic fixture values are deliberately non-secret test data; they are not a working Shifter account.

Run `sh scripts/configure.sh` to generate missing local files. It never overwrites an existing local configuration. Generated files are created with restrictive permissions. Before adopting updated templates, compare them with your local copies and apply changes deliberately.

`.gitignore` excludes local YAML/CFG/TOML files, environment files, credentials directories, certificates/keys, build products, logs, artifacts, and local-only research/report files. Explicit `*.example.*` templates, dependency manifests, source, tests, and this documentation are tracked. `.dockerignore` uses a build-context allowlist so local configuration and evidence do not enter Docker builds.

The HTTP server never serves the repository root. Both the API's demo and the gateway serve only explicitly allowed browser assets from their respective `web/control`, `web/runtime`, and published `web/sdk` directories. Unknown files, dotfiles, configuration, backups, SDK source directories, source maps, encoded aliases, traversal paths, and symlinked assets return 404 with `Cache-Control: no-store`. Adding a new public asset requires updating `src/public_assets.rs`; SDK releases accept numeric `major.minor.patch` directories and only the release's client, CAPTCHA module, and manifest. Runtime dependencies remain at their pinned versions.

Keep `.env.captcha` and `.secrets/recaptcha-secret` outside `web/`, ignored by Git, with host permissions 600 (the `.secrets` directory should be 700). The public site key is intentionally returned by `/api/v1/config`; the private secret is mounted read-only at `/run/secrets/recaptcha_secret` only in the API container, never in gateway containers, container environment variables, or images. Docker build exclusions also cover nested secret directories, environment/configuration files, keys, backups, and database files accidentally placed beneath an allowed source directory. Production serves a read-only container filesystem; do not mount the checkout, secret directories, or writable content into public asset roots. Git ignore rules alone do not provide HTTP protection.

`node tests/public-files.mjs` probes the running local demo and runtime using raw GET/HEAD paths (including traversal and percent encoding) and checks that required public assets still load. The same denial probes run against the disposable production HTTPS ingress in `tests/https-deployment.mjs`. Rust tests plant synthetic sensitive files and symlinks inside a temporary public tree to verify that the guard denies them even when present. `node tests/build-context.mjs` builds a disposable image with synthetic secret files to verify Docker's actual exclusion rules. Local validation does not verify an existing public deployment; deploy these changes before relying on them at `proxy.example.net`.

Never put a real password in a template, a command-line argument, a Docker build argument, a frontend bundle, an issue, or a test-output file. Git ignore rules do not remove previously committed data: inspect the staged diff before every push.

## Requirements

- Docker with the Compose plugin, a running local Docker engine, support for BuildKit cache mounts and bridge gateway mode `isolated` (validated locally with Engine 29.4.0).
- A browser with service workers, SharedWorkers, and WebAssembly support. Browser compatibility beyond the observed local fixture flows is not established.
- Node.js 24 when running the host-side test scripts or vendoring assets outside Docker.
- Rust/Cargo compatible with Rust 1.94.1 when running host-side Rust checks. The Docker build includes the pinned toolchain.
- Python 3.11 or newer for `tests/secret-scan.py`; Python 3 for the offline README renderer.
- Available loopback ports 8080 and 8081 for the normal stack, or 8180 and 8181 for the isolated SDK test runner.

The build fetches pinned dependencies and base images. After the images and assets exist locally, the mock destination does not require a real upstream account or destination Internet traffic.

## Quick start with synthetic traffic

```sh
git clone https://github.com/leftclick-io/web-proxy.git
cd web-proxy

# Optional explicit bootstrap; stack.sh also runs it automatically.
sh scripts/configure.sh

# Build and start the API, two gateways, Redis, HAProxy, and mock upstream.
sh scripts/stack.sh mock
```

Open **http://localhost:8080** to inspect the UI. Synthetic backend tests use `http://fixture.test/` and never consume paid upstream traffic. Browser Search now requires verification: the mock backend accepts only one-use challenge records seeded directly by tests, not arbitrary checkbox state or Google's public test responses. Use the disposable SDK runner below for automated checks; use the local CAPTCHA overlay for real verification.

The fixture displays the configured exit country and a synthetic assignment marker. It provides a JavaScript fetch, navigation links, redirects, a synthetic username form, and a second virtual origin for cookie-isolation checks. Use only synthetic identities with the fixture.

Only the HAProxy listeners are published to the host:

| URL | Purpose |
| --- | --- |
| `http://localhost:8080` | Trusted controls and session API |
| `http://localhost:8081` | Isolated runtime origin and Wisp endpoint |

Use `localhost` consistently. Origin checks expect these exact origins; replacing the host with `127.0.0.1` changes the origin even though both reach loopback.

Localhost HTTP supports the service-worker secure-context exception. It does not validate production HTTPS certificates, WSS termination, or a production origin layout.

To stop the project while retaining its Redis volume:

```sh
sh scripts/stack.sh down
```

## Using a real Shifter account

The repository does not include a real credential file or a path to anyone’s existing secrets.

Create a private local file from the placeholder schema:

```sh
mkdir -p .secrets
chmod 700 .secrets
cp examples/shifter-credentials.example.toml .secrets/shifter.toml
chmod 600 .secrets/shifter.toml
```

Edit that ignored file locally and replace the placeholders with your account and password. The expected TOML structure is:

```toml
[shifter]
account = "YOUR_ACCOUNT"
password = "REPLACE_LOCALLY"
```

The account may include the `customer-` prefix; the loader removes it before constructing the full username. Supply the base account, not a username already decorated with country/SID flags.

Edit the ignored `.env` file:

```dotenv
SHIFTER_CREDENTIALS_FILE=./.secrets/shifter.toml
SHIFTER_REGION=blr
SESSION_SECONDS=1800
BYTE_LIMIT=104857600
```

Then start live development mode:

```sh
sh scripts/stack.sh live
```

The credential file is mounted read-only at `/run/secrets/shifter_credentials` in each gateway. The non-root container user must be able to read the mount under your Docker engine’s host-file permission mapping. If access fails, provision a suitably owned/group-readable secret for UID 10001; do not solve it by committing the file or making the secret world-readable.

The default regional hostname is `blr.p.shifter.io:443`. The selected exit country remains independent of this regional ingress setting.

Switching between mock and live recreates the application containers and interrupts current requests. The profiles use separate Redis databases: mock uses DB 1; live development uses DB 0. The live command removes the orphaned mock fixture container.

## HTTPS/WSS deployment

Use `compose.production.example.yaml` as a **standalone** stack. Do not merge it with `compose.example.yaml`, which supplies local HTTP and unauthenticated Redis. The production example uses your existing Redis and does not create, publish, or modify it.

```sh
sh scripts/configure.sh
mkdir -p .secrets/https .secrets/redis-tls
```

Edit the ignored `.env.production` generated from `deploy/production.example.env`:

- `RUNTIME_HOST=proxy.example.net` is the public gateway hostname. Point its DNS record at the ingress host. Only HAProxy publishes ports 80 and 443. The API and gateway listeners stay on the internal ingress network; gateways have a separate outbound network for Shifter.
- `INTEGRATIONS` maps exact HTTPS origins to stable website IDs. The production environment example keeps `https://example.com` (`shifter`) and `https://second.example.com` (`ip-info`) and adds `https://staging.example.com` (`shifter`) for staging. Origins must be unique; explicitly configured aliases may share a site ID and its bearer-identity/quota namespace. Browser storage remains separate per origin, and CAPTCHA verification still checks the exact requesting hostname. Set the same mapping in API and gateways. Website IDs namespace quotas; do not rename them during an ordinary release. The built-in fallback still allows only the two production origins; staging requires this explicit setting. No implicit `www`, other subdomains, or localhost are added.
- Set `TLS_CERT_DIR` to a directory containing one or more `.pem` files, each with the full certificate chain followed by its private key. The certificate must cover `proxy.example.net` (or the configured `RUNTIME_HOST`). Provision certificates through your existing certificate manager or ACME DNS challenge workflow. The example does not issue or renew certificates automatically. Mount only the needed server PEM files, not an entire CA/ACME account directory.
- Set `REDIS_NETWORK` to the existing Redis Docker network. It must be an internal bridge with IPv4/IPv6 gateway mode `isolated`, no Redis published ports, and only Redis/API/gateways as members. HAProxy never joins it. For Redis on separate private infrastructure, adapt the application state-network attachment and firewall policy to that deployment; the supplied Compose topology assumes a shared Docker network.
- Set `REDIS_URL_SECRET_FILE` to an ignored file containing `redis://USER:URL_ENCODED_PASSWORD@PRIVATE_REDIS_HOST:6379/0` for the current private-network/password deployment. The hostname must resolve only to private addresses. Use a dedicated named ACL user, with unauthenticated default access disabled. No Redis TLS is required for this explicitly requested phase. Optional `rediss://` is also supported, with certificate and hostname verification.
- Leave `REDIS_CA_FILE` empty for the current plaintext private Redis deployment. If choosing optional Redis TLS later, use `rediss://`; for a private CA place its PEM bundle at `.secrets/redis-tls/ca.crt` and set `REDIS_CA_FILE=/run/redis-tls/ca.crt`. For a system-trusted CA, leave this variable empty. TLS certificate and hostname verification cannot be disabled. Mutual TLS client certificates are not configured by this example.
- Set `SHIFTER_CREDENTIALS_FILE` to the existing account TOML. Ensure application secret files and the CA are readable by container UID 10001, while restricting host access. HAProxy must be able to read its private keys. Never bake these files into images.

The least-privilege Redis ACL tested for application traffic permits `~daily:* ~ticket:* ~identity:* ~captcha:*` keys and commands `+get +set +ping +hello +select +client|setinfo +evalsha +script|load +exists +hset +pexpireat +hget +hincrby +hgetall +hdel +setex +getdel`. Apply this to a dedicated application user through your existing Redis administration process; do not replace operational or replication ACLs with this list.

Validate configuration, build, and launch **on the intended deployment host**:

```sh
docker compose --env-file .env.production -f compose.production.yaml config --quiet
docker compose --env-file .env.production -f compose.production.yaml run --rm --no-deps haproxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg
docker compose --env-file .env.production -f compose.production.yaml up -d --build --wait
```

HAProxy rejects unknown hostnames, redirects HTTP to the gateway HTTPS hostname, and terminates TLS 1.2 or later. On `proxy.example.net`, `/api/*` routes to the session API; `/wisp/*` and runtime assets route to the gateways. The control-page example is not published by this production ingress. WebSockets use HTTP/1.1 with an eleven-minute idle tunnel timeout. The browser automatically chooses WSS. The SDK uses cookie-free bearer authentication and exact-origin CORS. HSTS is set on backend responses. Public `/health` and `/metrics` requests are denied; backend health checks remain internal. Access logs are disabled to avoid storing Wisp tickets.

Certificate renewal: have your certificate manager atomically replace the fullchain-plus-key `.pem` files in the mounted directory, validate with the same HAProxy command, then recreate HAProxy to load them:

```sh
docker compose --env-file .env.production -f compose.production.yaml up -d --no-deps --force-recreate haproxy
```

Recreating HAProxy interrupts active Wisp connections. Schedule renewal deployment accordingly. Production requires server-verified CAPTCHA and site-bound credentials; only synthetic test mode enables the legacy cookie API.

Use the shared SDK integration above on either allowed website. The production ingress serves the library and runtime on `proxy.example.net`; `/api/v1/*` routes to the API service. The API has a separate outbound network for Google verification and remains attached to private Redis.

Validate HTTPS locally with a disposable production-mode stack:

```sh
docker build -t shifter-web:https-check .
HTTPS_TEST_REDIS_TLS=1 node tests/https-deployment.mjs
```

The test uses disposable certificates and ACL secrets, the real production HAProxy configuration and application mode, and a private isolated Redis network with ACL/password authentication. Run again with `HTTPS_TEST_REDIS_TLS=1 node tests/https-deployment.mjs` to check the optional encrypted Redis path. It checks redirects, certificate trust, cookie-free bearer access, exact CORS, production legacy-API rejection, and rejection of foreign Origins, authenticated WSS, ticket reuse rejection, invalid Redis passwords/hostnames/CAs, unauthenticated Redis rejection, application connectivity, HAProxy isolation, and failure when quota storage stops. Only loopback ingress ports are published; Redis has none. Test containers and fixture credentials are removed afterward. Passing these checks does not establish browser compatibility or validate an existing production Redis server.

Configuration references: [HAProxy WebSocket support](https://www.haproxy.com/documentation/haproxy-configuration-tutorials/protocol-support/websocket/) and [Redis Rust 0.32.7 TLS features](https://docs.rs/crate/redis/0.32.7).

## Configuration reference

The example Compose environment supplies the following defaults. Customize the ignored `.env` and local Compose files as needed.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SHIFTER_CREDENTIALS_FILE` | Mock fixture path in the example | Host-side path mounted as the live gateway secret |
| `SHIFTER_REGION` | `blr` | Explicit Shifter ingress region |
| `SESSION_SECONDS` | `1800` | Daily browsing window, maximum 1800 seconds (30 minutes) |
| `BYTE_LIMIT` | `104857600` | 100 MiB combined destination payload per UTC day |
| `MAX_STREAMS` | `32` | Concurrent destination streams per Wisp connection; configuration maximum 128 |
| `STREAM_RATE` | `8` | New destination streams per second |
| `STREAM_BURST` | `16` | Redis token-bucket burst size |
| `CONNECT_TIMEOUT_SECONDS` | `15` | DNS plus authenticated upstream establishment timeout |
| `IDLE_TIMEOUT_SECONDS` | `60` | Destination-stream idle timeout |

A separate protocol-flood guard terminates a Wisp connection after more than 32 CONNECT packets within its one-second admission window. Raising the token-bucket settings does not remove that guard.

These advanced settings are set in the local Compose environment or supplied when running the binary directly:

| Variable | Example/default | Meaning |
| --- | --- | --- |
| `APP_ENV` | `development`, `test`, or `production` | Production requires distinct HTTPS origins and private Redis with a named ACL user/password; optional Redis TLS is certificate-verified. The API requires real reCAPTCHA credentials; SDK identity is a site-bound bearer credential. |
| `ROLE` | `api` or `gateway` | Binary role |
| `REPLICA` | `api`, `gateway-a`, `gateway-b` | Operational identity for health/metrics |
| `LISTEN` | `0.0.0.0:3000` | Listener inside the container |
| `REDIS_URL` | `redis://redis:6379/` | Local shared session store; production allows private `redis://` with named ACL credentials, or optional verified `rediss://` |
| `REDIS_URL_FILE` | `/run/secrets/redis_url` in production | Read the connection URL from a secret file; takes precedence over `REDIS_URL` |
| `REDIS_CA_FILE` | Empty (system trust) | Optional PEM CA bundle for private Redis TLS; hostname verification always remains enabled |
| `INTEGRATIONS` | Two production websites; localhost in development | JSON array of exact `{origin, site}` mappings |
| `CONTROL_ORIGIN` | `http://localhost:8080` | Legacy synthetic-test origin and local default only |
| `RECAPTCHA_SITE_KEY` | Empty outside tests | Public standard v2 checkbox key; required in production |
| `RECAPTCHA_SECRET_FILE` | None | API-only mounted secret file; required in production |
| `RUNTIME_ORIGIN` | `http://localhost:8081` | Exact runtime/WebSocket origin |
| `CREDENTIALS_FILE` | `/run/secrets/shifter_credentials` | In-container credential path |
| `WEB_DIR` | `/app/web` in Docker | Static asset root |

Country availability is generated from the [Shifter session-manager weights](https://github.com/leftclick-io/session-manager/blob/master/config/weights.json). Sum only `shifter` leaf counts within each country in `locations`; include countries with a total **strictly greater than 250**. The current snapshot yields **54 countries**. This is a weights-based snapshot, not a live availability check. Both the country API and gateway validation use the same generated allowlist. Missing or unlisted countries are rejected; country targeting is never silently omitted.

The searchable country picker groups eligible locations into Tier 1, Tier 2, and Tier 3, with the US, UK, Canada, Germany, Italy, and France first. These are configurable product display priorities in `web/control/country-order.js`, independent of the IP-count eligibility filter. Filtering search results preserves that order, and future weights refreshes cannot replace it with alphabetical order. Countries not explicitly prioritized fall into Tier 3 alphabetically. The picker defaults to the United States and uses the Astro site’s existing circular SVG flags and country names. Flags appear in the selected value and every menu option, in both the landing page and browser toolbar. Keyboard users can search, move with arrow keys, select with Enter, and dismiss with Escape.

To refresh, obtain the latest weights JSON through authenticated GitHub access into an ignored location or outside the repository, then run:

```sh
node scripts/sync-countries.mjs /path/to/weights.json /path/to/Shifter-Astro
node --test tests/countries.test.mjs
```

The importer updates `src/config.rs` and copies eligible flags from the Astro checkout. It does not copy provider weights, counts, or operational metadata into this repository. Rebuild the API and gateways together after refreshing the list. The boundary test excludes a country at exactly 250 and ensures other providers cannot make a country eligible.

The regional allowlist is `fra`, `ams`, `lon`, `nyc`, `tor`, `sgp`, `blr`, and `syd`. Only the BLR upstream was exercised in the initial live validation.

## Redis security rules

**Redis must run exclusively on private network addresses in every region. Public Redis endpoints and published Redis ports are prohibited.** This applies to primary/replica instances, Sentinel, and cluster management ports.

The permanent project rule is [Redis security rule](.cursor/rules/redis-security.mdc), referenced by [AGENTS.md](AGENTS.md). It applies to application, infrastructure, example configuration, and operational changes.

The local Compose example attaches Redis only to `session_state`, a bridge network with `internal: true` and `isolated` gateway mode for IPv4 and IPv6. The API and both gateways join that network and the separate default network. HAProxy and the synthetic destination stay off the state network. Redis publishes no host port, including loopback port mappings. Its `6379/tcp` image metadata in `docker compose ps` is not a published host listener; any `HOST:PORT->6379` mapping would violate the rule. Docker host administrators retain privileged access to container networks; this isolation does not defend against a compromised host or Docker administrator.

The explicit bridge mode is required: on the development device, `internal: true` alone still allowed a direct connection from HAProxy to Redis. With `isolated` mode, the deployed-container check confirms that the API and both gateways can use Redis while HAProxy cannot connect to its private port. Run this check on each deployment engine; do not remove the isolation options to work around an unsupported engine.

For an existing checkout, `scripts/configure.sh` preserves local files. Merge the network changes from `compose.example.yaml` into your ignored `compose.yaml`, then recreate this project’s containers and networks with `docker compose down` followed by your usual stack start command. Do not pass `--volumes`: the Redis data volume must survive. This interrupts active local browsing connections.

Production requirements (the current phase explicitly overrides the baseline Redis TLS requirement with private-network ACL/password authentication):

- Private IPs and private DNS only; no public IP, public load balancer, public DNS endpoint, NAT/port forwarding, or host-network shortcut for Redis.
- Bind Redis only to private interfaces and necessary loopback addresses. Firewall/security groups deny access by default, allowing the regional API/gateways and explicitly approved private administration, monitoring, and replication peers.
- Require named ACL users with least-privilege key and command permissions; disable unauthenticated default access. Keep protected mode enabled.
- The project baseline calls for verified TLS for client and replication connections. For this deployment phase, the user explicitly selected private-network ACL/password authentication without Redis TLS. The application supports that mode; private networking and authorization remain mandatory. Optional TLS always verifies certificates and hostnames.
- Keep credentials, ACL material, certificates, private keys, and actual regional configuration in secret storage or ignored local files. Do not log authenticated Redis URLs.
- Continue failing closed when authorization or quota storage is unavailable.

The local configuration uses unauthenticated Redis **only inside its isolated Docker state network in development/test mode**. Production requires a named ACL user and password on private Redis; plaintext TCP is supported for this phase. Optional Redis TLS supports a private CA bundle. Startup rejects insecure TLS verification, default/missing ACL users, and Redis DNS resolving outside RFC1918/ULA space. Network isolation alone must not be described as complete production hardening.

Run the policy rejection checks and the deployed-container checks after networking changes:

```sh
node --test tests/redis-network-policy.test.mjs
node tests/configuration.mjs
```

The configuration check rejects Redis host port mappings, host networking, non-internal networks, missing isolated bridge modes, non-private assigned IPs, and unexpected state-network members. It also confirms application Redis access and requires a direct connection attempt from HAProxy to fail. These are local Docker checks; actual cloud firewall rules, private endpoint settings, ACLs, certificates, and regional replication access require deployment-specific verification.

These requirements follow the [Redis security guidance](https://redis.io/docs/latest/operate/oss_and_stack/management/security/) and [Docker Compose internal network configuration](https://docs.docker.com/reference/compose-file/networks/#internal), and [Docker isolated gateway mode](https://docs.docker.com/engine/network/port-publishing/#gateway-modes).

## Session lifecycle and limits

### Identity and daily allowance

The SDK persists a server-generated 256-bit opaque credential in the embedding website's first-party local storage, scoped to API origin and website ID. Redis stores only its SHA-256 hash and an anonymous visitor/site mapping, with a 30-day expiry refreshed only after successful CAPTCHA-backed session creation. Requests omit cookies. The runtime receives only one-use tickets, never the persistent credential. Daily session keys include both website ID and visitor ID.

Deleting storage or changing browser profiles can obtain another anonymous identity after CAPTCHA. This is not an unresettable per-person quota. Scripts trusted by the embedding website can access its storage, so that website's XSS protections remain important. A stopped session retains its credential and allowance. Legacy `shifter_dev` cookies are accepted only in `APP_ENV=test`.

On first session creation, Redis records the visitor’s country, SID, region, expiry, byte usage, limit, revision, and stopped state. The browsing window starts immediately, including time spent idle or stopped. Its expiry is the earlier of the configured duration and the next UTC midnight.

The daily allowance is shared across streams and replicas. Reconnects, country changes, Stop, and resume do not reset time or byte usage. Session records remain long enough to enforce the daily allowance rather than disappearing when browsing stops.

### Connection authorization

1. The trusted UI requests a short-lived ticket from the session API.
2. The API creates a random ticket containing an immutable session snapshot and a 30-second TTL.
3. The trusted page sends the ticket to the runtime using exact-origin `postMessage` with source-window validation.
4. The runtime opens the authenticated Wisp WebSocket.
5. The gateway atomically consumes the ticket using Redis GETDEL, then atomically validates the session revision and claims its connection lease.
6. An active owner blocks another simultaneous connection for the same daily visitor record.
7. Backend checks renew the six-second lease approximately every second and verify expiry, revision, ownership, and available bytes.

A ticket cannot be reused. Country changes, revocation, and explicit reconnect revision changes invalidate previously issued tickets. The browser cannot supply an upstream SID, account, password, or host through the API.

### Forwarding quota

Before forwarding each chunk, a Redis script validates authorization and reserves up to 16 KiB from the shared allowance. Both directions count, including destination TLS traffic. Wisp/control framing is not destination payload. A failed write may conservatively consume its reservation; quotas do not depend on a delayed after-the-fact counter.

Storage errors fail authorization/forwarding closed. Existing connections are also monitored while idle. An interface countdown alone does not grant or revoke access.

### Country changes, Stop, and reconnect

Changing country revokes the old connection, generates a fresh SID, preserves the original allowance, and starts a clean proxied website context. Sites may require login again.

Stop revokes active access and requests website-state cleanup. Resuming uses the same daily time/byte budget and creates a new assignment after a stopped session.

Reload performs an explicit reconnect, retains country/SID/region/allowance, waits for the old connection lease to clear, and reloads the displayed address. Interrupted form submissions are not automatically replayed. Browser cookie retention across this reconnect still needs final acceptance testing.

Different SIDs represent independent assignment requests. They do not guarantee globally unique residential IPs. Even a sticky SID can receive a new IP when its residential peer disconnects or its upstream TTL expires.

## Browser integration and isolation

The embedding website supplies its UI. The runtime on a separate origin owns Scramjet, its service worker, bare-mux SharedWorker, Epoxy, and a sandboxed destination iframe. No service worker is installed on either website by the SDK. Runtime and reset documents validate the configured parent origin, actual parent window, protocol version, and per-instance channel identifier. Unknown or stale messages are ignored. `frame-ancestors` limits browser embedding to self and configured websites.

The integration does not require site-wide COOP/COEP headers. The pinned Scramjet version runs with synchronous XHR disabled. Destination features requiring cross-origin isolation or SharedArrayBuffer are not supported in this mode. Browser service-worker, SharedWorker, WASM, and third-party storage restrictions can still affect compatibility; the SDK reports initialization errors/timeouts. It cannot override a website's restrictive CSP. Allow the SDK script/module origin, API connect origin, runtime frame origin, and Google's reCAPTCHA script/frame/connect resources as appropriate to that website's policy. Use CSP nonces for injected scripts/styles when required.

The runtime clears its local/session storage, service-worker registrations, caches, and IndexedDB contents on reset. Stop removes the engine frame before running reset in an independent offscreen iframe, so a website hiding its viewport cannot interrupt cleanup. Runtime/reset assets bypass the service worker’s engine configuration read, allowing reset to finish after storage is cleared. Stop waits for acknowledgement; a cleanup failure is surfaced. Cleanup is not forensic erasure. Server revocation and quotas remain effective when browser cleanup fails. Runtime cookies and emulated destination origins still need adversarial review: rewriting does not provide browser-enforced origin isolation between every proxied destination. No persistent SDK credential is stored at the runtime origin.

## API reference

All SDK API calls use `/api/v1`. Send the embedding site's exact `Origin`; authenticated routes additionally require `Authorization: Bearer <credential>`. Browsers omit Origin on same-origin GETs: these are accepted only with same-origin Fetch Metadata and a matching configured Host. Credentialed CORS is not used. JSON requests have a 16 KiB body limit; CAPTCHA response tokens have an 8 KiB field limit.

| Route | Body | Result |
| --- | --- | --- |
| `GET /api/v1/config` | None | Countries, site ID, runtime origin, public CAPTCHA site key, protocol version |
| `POST /api/v1/sessions` | `{country, captchaToken}` | `{session, credential}`; credential returned only for a new identity |
| `GET /api/v1/session` | None | Current allowance and status |
| `POST /api/v1/session/tickets` | None | One-use ticket, session revision, 30-second TTL, runtime origin |
| `POST /api/v1/session/country` | `{country}` | Updated assignment; allowance retained |
| `POST /api/v1/session/reconnect` | None | Old connection revision revoked |
| `POST /api/v1/session/recover` | `{revision, url, reason}` | Bounded recovery; reason is `websocket` or `upstream`; returns `{status, retryAfterMs}` |
| `DELETE /api/v1/session` | None | Stopped access |

Public session fields are `country`, `status`, `serverTime`, `expiresAt`, `remainingBytes`, `byteLimit`, and `connected`. Times are Unix milliseconds; upstream credentials/SID are private. Session status is `active`, `stopped`, `expired`, or `exhausted`.

Error responses use `{code, error}`. Codes include `ORIGIN_DENIED`, `AUTH_REQUIRED`, `NO_SESSION`, `INVALID_INPUT`, `INVALID_COUNTRY`, `CAPTCHA_REQUIRED`, `CAPTCHA_REJECTED`, `CAPTCHA_UNAVAILABLE`, `SESSION_ENDED`, `RECOVERY_UNAVAILABLE`, and `STORAGE_UNAVAILABLE`. Verification failures never silently mint another credential. An invalid saved credential returns 401; the SDK discards it and the visitor retries Search with a new challenge.

The runtime keeps `/wisp/?ticket=...` and `/wisp/<ticket>/` WebSocket routes. Only its exact Origin can redeem tickets. Forged/reused/expired tickets, unavailable sessions, ownership conflicts, regional mismatches, and Redis failures deny access. `/settings` exposes only allowed parent origins and protocol versions. `/health` and `/metrics` stay internal at the production ingress.

The old `/api/*` cookie endpoints are available only for isolated synthetic transport regression tests. They are absent in production and development.

## Gateway forwarding and destination policy

The gateway uses Tokio and pinned `wisp-mux` components for framing and multiplexing. It does not implement a second browser or replay website requests on the server.

For each destination stream, the gateway:

1. Checks stream type, concurrent-stream admission, and the shared rate bucket.
2. Allows only TCP destination ports 80 and 443; UDP is rejected.
3. Resolves the requested hostname locally, validates the returned addresses, and rejects blocked destinations.
4. Constructs the Shifter username using the immutable authorized session context.
5. Authenticates with SOCKS5 to the explicit regional Shifter endpoint.
6. Requests the validated destination IP through that proxy.
7. Forwards bytes while enforcing quota, idle timeout, expiry, and revocation.

The username format is:

```text
customer-<account>-country-<country>-strict-true-sid-<128-bit-random-hex>-ttl-1800-pool-shifter
```

The final `pool-shifter` flag restricts upstream assignments to the Shifter pool. The gateway always adds it server-side; visitors cannot choose or override the pool.

Account syntax and SOCKS5 credential lengths are validated. Authentication failures do not trigger a direct-connect fallback. Authenticated upstream sockets are not shared between sessions.

The destination policy rejects private/reserved IPv4/IPv6 ranges, loopback, link-local, multicast, mapped/translation ranges, local/internal names, Shifter infrastructure hostnames, and the configured upstream’s resolved addresses. DNS answers containing a blocked address are rejected rather than selecting a different answer. Connecting to the validated IP prevents a second, unchecked destination DNS lookup by the upstream proxy.

The destination’s original TLS hostname remains available to the browser transport. The live Node TLS smoke test separately checked opaque TLS forwarding with hostname/certificate verification enabled; it does not validate production frontend certificates or browser-wide compatibility.

The reserved `fixture.test`, `second.test`, and `failed-upstream.test` mappings exist only in test mode. The synthetic SOCKS server serves fixture responses or a deliberate SOCKS failure without opening destination Internet connections.

## HAProxy, regions, and recovery

Local HAProxy runs in TCP mode; the production example terminates HTTPS in HTTP mode. Both use `leastconn`, backend health checks, Docker DNS resolution, and an eleven-minute connection/tunnel idle timeout. A gateway sends periodic WebSocket pings. Backend allowance enforcement still ends browsing at its own shorter session deadline.

**HAProxy balances connections, not individual requests inside a Wisp connection.** An established WebSocket remains attached to one replica. Independent visitors and later reconnects may select different replicas.

If a replica stops, in-flight requests can fail. SDK 1.0.2 automatically reconnects eligible failed GET document loads within its retry budget; unsafe submissions and exhausted retries require user action. The surviving replica reads shared Redis state and preserves the session’s country, SID, region, and remaining allowance. A crashed replica’s lease may take up to six seconds to expire, in addition to health-check/routing recovery time.

The production design should place a regional HAProxy in front of healthy replicas in that same region. Each replica should use the corresponding explicit Shifter regional hostname. Geographic/latency-aware DNS can select a nearby healthy ingress region; it cannot guarantee the nearest server for every visitor.

The gateway binds sessions to their assigned region and rejects a region mismatch. Cross-region recovery that preserves allowance while creating a fresh residential assignment is not implemented. It must not silently promise IP continuity across regions.

## Testing and validation

### Install host-side test dependencies

```sh
npm ci --ignore-scripts
sh scripts/stack.sh mock
```

The Docker asset build runs the vendoring script itself. To populate local generated assets for inspection:

```sh
npm run vendor
```

Generated vendor files are ignored by Git and excluded from the input Docker build context.

### Mock and code checks

```sh
node tests/integration.mjs
node tests/limits.mjs
node tests/load.mjs
node tests/failover.mjs
node --test tests/redis-network-policy.test.mjs
node tests/configuration.mjs
cargo test --locked
cargo clippy --all-targets -- -D warnings
npm audit --audit-level=high
```

| Check | Coverage |
| --- | --- |
| `integration.mjs` | Country validation, Origin checks, forged/reused tickets, per-visitor country/SID isolation, one active connection, malformed Wisp, forbidden destinations/ports/UDP, reconnect context, country revocation, synthetic form response, shared byte cap, expiry, Stop/resume allowance |
| `limits.mjs` | Ticket TTL/expiry, outstanding ticket revocation, unauthorized country changes, sixteen-stream burst, thirty-two-stream concurrency cap |
| `load.mjs` | 10, 100, 500, and 1,000 simultaneous mock sessions; two 128 KiB requests per session; errors, latency percentiles, throughput, replica counts, sampled Docker CPU/memory |
| `failover.mjs` | Different countries on one replica, replica failure/recovery with preserved SID/allowance, Redis outage and fail-closed behavior |
| `configuration.mjs` | Production-mode rejection, read-only gateway secret mounts, loopback-only application listeners, private/internal Redis with no published ports, isolated bridge modes, restricted network membership, working application access, and blocked HAProxy access |
| `redis-network-policy.test.mjs` | Rejection of published Redis ports, host networking, non-internal networks, missing isolated bridge modes, public addresses, and unauthorized network members |
| Rust unit test | Representative allowed/blocked destination addresses |

Load tests refuse live mode. Failover tests deliberately stop/start gateways and pause/unpause Redis. Use a dedicated local test stack and do not run those tests while using the browsing UI. The scripts restore stopped services in cleanup paths, but inspect the stack after any externally interrupted test.

Results are written under ignored `artifacts/`. They can contain local resource information, synthetic identifiers, or live IP addresses; do not commit the raw results.

To change mock load stages:

```sh
LOAD_STAGES=10,100,500,1000 node tests/load.mjs
```

These are short synthetic bursts, not production capacity measurements or a sustained saturation benchmark. Docker CPU samples may include setup or idle periods, and browser JavaScript execution is outside this server load test.

### Reset synthetic browsing state

```sh
node tests/reset-mock.mjs
```

This command refuses live mode and clears only this project’s mock Redis DB 1. It allows a new fixture run after the daily window ends. Normal user flows do not reset the daily allowance.

### Explicit live smoke checks

After configuring a real private credential file:

```sh
sh scripts/stack.sh live
node tests/live-smoke.mjs
node tests/live-tls.mjs
```

The country test checks US and DE using `second.example.com/json`, with three samples per country including a Wisp reconnect. The TLS test fetches `https://example.com` through the Wisp/Shifter path with Node certificate verification enabled.

The scripts inspect existing usage in the dedicated live-development Redis DB 0 and reserve bounded per-visitor quotas within a cumulative **20 MiB** test ceiling. Run them serially on a dedicated stack. This is test accounting, not a global production billing limiter; unrelated concurrent visitors or simultaneous test runners are outside that cumulative-test calculation. Do not clear DB 0 to bypass the smoke-test cap.

Live smoke scripts print observed IP addresses and store them in ignored artifacts. No upstream credentials should appear in their output.

### Credential scan

```sh
# Requires .env to reference the real private credential file and Python 3.11+.
python3 tests/secret-scan.py
```

The local scan compares exact upstream account/password and configured local CAPTCHA secret values against source, generated assets, test evidence, application/HAProxy logs, image metadata/history, and the final image filesystem without printing those values. It supplements review; it does not prove the absence of every possible secret or replace a staged-file audit.

### Shared SDK validation

```sh
npm test
cargo test
node scripts/build-sdk.mjs
docker build -t shifter-web:sdk-check .
node tests/run-sdk-tests.mjs
HTTPS_TEST_IMAGE=shifter-web:sdk-check HTTPS_TEST_REDIS_TLS=1 node tests/https-deployment.mjs
```

The SDK runner creates a separate disposable local project on loopback ports 8180/8181, runs the origin/CAPTCHA/identity/cache checks, existing transport/quota integration tests, and Redis network-policy checks, then removes that project. It never rewrites the developer's active configuration. `--keep` retains it for browser checks and writes its cleanup context under ignored `artifacts/`.

Recovery tests cover hidden error documents, worker capability validation, website HTTP-error passthrough, POST safety, stale frames, retry limits, Stop/destruction cancellation, gateway-attested SID rotation, concurrent recovery, and unchanged quota/expiry. The TLS fixture also exercises recovery under the production Redis ACL and verifies that storage loss denies recovery. Automated runtime tests use a simulated DOM/service-worker bridge; a real-browser recovery acceptance run remains necessary.

Unit tests cover modal cancellation, concurrent clicks, errors, bearer requests, stale messages, storage denial, cleanup, and Google challenge focus handling. The TLS fixture seeds a verified synthetic identity directly in its private Redis for WSS testing; it does not claim to solve a real CAPTCHA or expose a production bypass. Real credentials are never used by synthetic tests. Local browser checks exercised the branded and minimal UIs on different local site origins, mobile and desktop browsing, cancellation, and Stop/cleanup. Google’s live widget script was unavailable in that browser session; synthetic verification was used for successful session flows. Real Google challenge acceptance on the two production websites remains outstanding.

### Validation status at the initial implementation

- Twenty-two backend integration, limit, and outage checks passed.
- The 1,000-session mock stage completed 2,000 requests with zero errors and distributed connections across both gateways.
- Live US/DE targeting and sampled sticky behavior passed through the BLR endpoint.
- Node TLS forwarding with certificate verification passed.
- Total recorded live validation traffic was 19,314 destination bytes, including an initial incomplete test-client attempt.
- The destination-policy Rust unit test, Clippy, dependency audit, configuration checks, and exact-value credential scan passed at the time of validation.
- Embedded fixture HTML/JavaScript, a synthetic login, and subsequent link navigation were observed in the browser.
- Final browser idle stability, Back/Forward, full redirect/cookie separation, reconnect cookie retention, and Stop/country/expiry cleanup remain pending.

Raw local reports, live IPs, and workstation-specific evidence are intentionally not published in this repository. Rerun the included checks to produce evidence for your checkout and device. The summary above is a historical observation, not a promise that future dependency or environment changes will pass.

### Remaining manual browser acceptance

1. Start the mock stack, open the trusted page, and browse `http://fixture.test/`.
2. Confirm the JavaScript country message and submit the synthetic username form.
3. Follow Next page, then use Back and Forward; confirm navigation and login state.
4. Leave the page idle for at least one minute, then navigate again and check connection stability.
5. Verify Redirect, visit Second origin, and confirm that the first origin’s login does not appear there.
6. Return to the first origin and confirm its login remains; use Reload and check reconnect cookie retention.
7. Change country and confirm a fresh website context with the original allowance retained.
8. Stop and resume; confirm website state is cleared while time and byte usage remain shared.
9. Expire a session while traffic is active; verify both backend closure and the VPN informational state.
10. Interrupt/reload the tab and check next-load cleanup. Perform any additional public-site browser tests under a separately bounded live test budget.

## Operations and troubleshooting

### Inspect the local services

```sh
docker compose ps
docker compose logs --tail 50 api gateway-a gateway-b haproxy
curl -fsS http://localhost:8080/health
curl -fsS http://localhost:8081/health
```

The runtime listener balances independent HTTP connections as well as WebSocket connections, so repeated health requests can report different replicas. Metrics contain counters, not destination URLs or visitor labels. There is intentionally no request URL/access logging; adding it could expose tickets and browsing history.

### Common issues

| Symptom | Checks and action |
| --- | --- |
| Compose cannot find local configuration | Run `sh scripts/configure.sh`. It copies examples only when local files are missing. |
| Live secret cannot be read | Check the ignored `.env` path, TOML schema, and UID 10001 mount readability. Do not put the secret in an image or template. |
| API denies a request Origin | Use `http://localhost:8080` for controls and preserve the configured runtime origin. Update both settings together if changing origins. |
| A second tab cannot connect | One connection is allowed per visitor. Stop the other session or use explicit reconnect and wait for lease cleanup. |
| Reconnect is briefly denied after a crash | Allow the six-second lease and HAProxy health checks to converge. The same country/SID/allowance should be retained. |
| Daily allowance ended | This is expected after expiry/exhaustion. Reconnect and country changes must not reset it. Reset DB 1 only for synthetic tests. |
| Fixture hostname fails in live mode | Fixture mappings are test-only. Start the mock profile for fixture checks. |
| Redis is paused after interrupted outage testing | Inspect the project, then use `docker compose unpause redis` and `docker compose start gateway-a gateway-b`. |
| Runtime cannot initialize | Check service worker, SharedWorker, WebAssembly support, exact origins, and generated asset availability. |
| Browser loses the connection or a website fails | This remains an open compatibility/regression area. Use explicit Reload; do not automatically replay form submissions. |
| Template changes do not appear locally | Bootstrap preserves local copies. Compare the example with the ignored local file and apply the change yourself. |

Redis uses an AOF-backed named volume and a no-eviction memory policy in the example. `stack.sh down` preserves that volume. Deleting it removes the local allowance ledger. Redis high availability, backup/restore policy, crash-durability guarantees, and production observability remain deployment work.

Production uses server-verified CAPTCHA and anonymous bearer identity. Clearing first-party storage can still reset anonymous identity; verified per-person identity and stronger abuse controls are separate work.

## Project layout

```text
src/
  main.rs                     Role selection, routing, headers, process setup
  config.rs                   Validated settings and server-side credential loading
  api.rs                      Session API, trusted controls, health and metrics
  store.rs                    Redis session state, tickets, leases and quotas
  relay.rs                    Wisp adapter, admission, destination policy and SOCKS5
web/
  control/                    Shifter UI adapter and minimal integration example
  sdk/                        SDK source, stable loader, immutable release assets
  runtime/                    Scramjet setup, service worker and state cleanup
scripts/
  configure.sh                Create missing ignored local files from examples
  stack.sh                    Local mock/live/down lifecycle
  vendor.mjs                  Copy locked browser dependencies into generated assets
  render-readme.py            Produce self-contained HTML documentation
examples/
  shifter-credentials.example.toml  Placeholder live-account schema
deploy/
  haproxy.example.cfg         Portable TCP balancer template
tests/
  fixtures/                   Synthetic SOCKS5/destination and mock credential example
  client.mjs                  Wisp protocol client and TLS tunnel helper
  integration.mjs             Core authorization, isolation, quota and expiry checks
  limits.mjs                  Ticket and stream-admission checks
  load.mjs                    Increasing-concurrency mock benchmark
  failover.mjs                Gateway/Redis outage checks
  configuration.mjs           Deployment-default assertions
  live-smoke.mjs              Bounded real country/sticky-IP checks
  live-tls.mjs                Bounded real TLS-forwarding check
  reset-mock.mjs              Reset only isolated mock data
  secret-scan.py              Local exact-value credential scan
compose.example.yaml          Portable development stack example
compose.test.example.yaml     Synthetic test-profile example
Dockerfile                    Multi-stage source/asset build, non-root runtime
Cargo.toml / Cargo.lock        Rust dependencies
package.json / package-lock.json  Browser and test dependencies
README.md                     GitHub documentation source
docs/readme.html              Offline standalone HTML version
```

Local-only configuration, artifacts, generated dependencies, and pre-existing research documents are omitted from this layout because they are not repository deliverables.

## Dependencies and reproducibility

| Component | Pin |
| --- | --- |
| Scramjet | Release tarball `1.1.0`, locked in `package-lock.json` |
| bare-mux | `2.1.9` |
| Epoxy transport | `2.1.19` |
| wisp-mux | epoxy-tls Git revision `0c11678d72a636c3a4bc723db87e03e7b888eaf9` |
| Node build stage | Node 24 image pinned by digest |
| Rust build stage | Rust 1.94.1 image pinned by digest |
| HAProxy / Redis / fixture Python | Example image tags plus immutable digests |

Use `npm ci --ignore-scripts` and Cargo’s `--locked` mode. The Docker build follows those locked inputs and generates browser assets during the build. Container digests and lockfiles improve repeatability; this is not a claim of fully bit-for-bit reproducible images, since operating-system packages are installed during the build.

Review transport/runtime compatibility when updating dependencies. Their contracts, browser isolation behavior, service-worker caching, and Wisp protocol behavior matter as much as version numbers. The pinned versions and known browser gaps need review before any public rollout.

Regenerate the standalone README after editing Markdown:

```sh
python3 scripts/render-readme.py
```

The HTML file embeds its styling, has no CDN dependencies, and opens without a development server.

This repository does not grant a blanket license for third-party components. Upstream licenses, including AGPL terms for relevant proxy components, remain applicable. Review their obligations before distributing or hosting a modified public service.

## Production work still required

- Complete the pending browser acceptance procedure and investigate any remaining idle/navigation failures.
- Validate representative public websites and supported authentication flows; define a compatibility policy.
- Provision the real v2 CAPTCHA key/secret and register both domains; verify real Google challenge acceptance on both websites. Consider stronger identity and abuse monitoring if anonymous quotas are insufficient.
- Add broader service-level admission controls, operational resource limits, and sustained load testing.
- Review engine isolation and escape risks for the requested original-site integration: controls at the configured Shifter origin and the runtime at `proxy.example.net` are distinct origins on the same registrable domain.
- Provision real-domain certificates and renewal on the deployment host using the HTTPS/WSS example below; complete browser acceptance against those domains.
- Verify the existing production Redis deployment against the rules above: private endpoints, named ACL users, and network access restrictions; verify certificates if optional Redis TLS is enabled. Client ACL/TLS support is implemented and covered by local integration checks.
- Establish regional Redis/state availability and an explicit cross-region recovery protocol that preserves allowance but rotates residential assignment.
- Deploy regional HAProxy/gateway groups and geographic/latency-aware DNS, with health-aware routing.
- Add production telemetry that protects browsing privacy and excludes credentials, connection tickets, and destination URLs.
- Configure a real VPN download destination and final expired-session UX.

The HTTPS implementation and tests run locally. Production DNS changes, certificate issuance, and execution on a deployment host are separate operational steps; no remote deployment was performed.

References: [Scramjet](https://github.com/MercuryWorkshop/scramjet), [epoxy-tls and Wisp](https://github.com/MercuryWorkshop/epoxy-tls), [HAProxy TCP configuration](https://www.haproxy.com/documentation/haproxy-configuration-tutorials/protocol-support/tcp/), [Shifter gateway and regions](https://shifter.io/docs/products/residential-proxies/gateway-and-auth/), [Shifter geo-targeting](https://shifter.io/docs/products/residential-proxies/geo-targeting/), and [Shifter sessions](https://shifter.io/docs/products/residential-proxies/sessions/).
