# Shifter Web Proxy

A web proxy that combines **Scramjet in the browser**, **HAProxy in TCP mode**, **Rust Wisp gateways**, **Redis session enforcement**, and **Shifter residential proxies**.

Visitors enter a website, choose an exit country, and browse inside the page without configuring their browser’s proxy settings. Each visitor receives a server-generated sticky session ID. The gateway adds the upstream credentials and country targeting on the server.

**Status: local deployment. Backend validation passed; final browser acceptance is incomplete.** Earlier browser runs experienced Wisp disconnections after navigation or idle. A WebSocket keepalive was added, but its final browser regression and the complete cookie-cleanup sequence remain unverified. This is not a production-ready public proxy.

An offline HTML version of this README is included at [docs/readme.html](docs/readme.html).

## Contents

- [What is included](#what-is-included)
- [Architecture](#architecture)
- [Repository and secret policy](#repository-and-secret-policy)
- [Requirements](#requirements)
- [Quick start with synthetic traffic](#quick-start-with-synthetic-traffic)
- [Using a real Shifter account](#using-a-real-shifter-account)
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

The VPN call-to-action is informational. A real app download URL, live CAPTCHA verification, and verified Fingerprint identity are not configured.

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
| `deploy/haproxy.example.cfg` | `deploy/haproxy.cfg` | TCP listeners, balancing, DNS resolution, health checks |
| `.env.example` | `.env` | Non-secret mock defaults; local credential-file path for live mode |
| `tests/fixtures/credentials.example.toml` | `tests/fixtures/credentials.toml` | Public synthetic values accepted only by the mock fixture |
| `examples/shifter-credentials.example.toml` | A file under `.secrets/` or outside the checkout | Placeholder schema for a real upstream account |

The synthetic fixture values are deliberately non-secret test data; they are not a working Shifter account.

Run `sh scripts/configure.sh` to generate missing local files. It never overwrites an existing local configuration. Generated files are created with restrictive permissions. Before adopting updated templates, compare them with your local copies and apply changes deliberately.

`.gitignore` excludes local YAML/CFG/TOML files, environment files, credentials directories, certificates/keys, build products, logs, artifacts, and local-only research/report files. Explicit `*.example.*` templates, dependency manifests, source, tests, and this documentation are tracked. `.dockerignore` uses a build-context allowlist so local configuration and evidence do not enter Docker builds.

Never put a real password in a template, a command-line argument, a Docker build argument, a frontend bundle, an issue, or a test-output file. Git ignore rules do not remove previously committed data: inspect the staged diff before every push.

## Requirements

- Docker with the Compose plugin, a running local Docker engine, support for BuildKit cache mounts and bridge gateway mode `isolated` (validated locally with Engine 29.4.0).
- A browser with service workers, SharedWorkers, and WebAssembly support. Browser compatibility beyond the observed local fixture flows is not established.
- Node.js 24 when running the host-side test scripts or vendoring assets outside Docker.
- Rust/Cargo compatible with Rust 1.94.1 when running host-side Rust checks. The Docker build includes the pinned toolchain.
- Python 3.11 or newer for `tests/secret-scan.py`; Python 3 for the offline README renderer.
- Available loopback ports 8080 and 8081.

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

Open **http://localhost:8080**. Enter **http://fixture.test/**, select a country, and choose **Browse**.

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
SESSION_SECONDS=600
BYTE_LIMIT=104857600
```

Then start live development mode:

```sh
sh scripts/stack.sh live
```

The credential file is mounted read-only at `/run/secrets/shifter_credentials` in each gateway. The non-root container user must be able to read the mount under your Docker engine’s host-file permission mapping. If access fails, provision a suitably owned/group-readable secret for UID 10001; do not solve it by committing the file or making the secret world-readable.

The default regional hostname is `blr.p.shifter.io:443`. The selected exit country remains independent of this regional ingress setting.

Switching between mock and live recreates the application containers and interrupts current requests. The profiles use separate Redis databases: mock uses DB 1; live development uses DB 0. The live command removes the orphaned mock fixture container.

## Configuration reference

The example Compose environment supplies the following defaults. Customize the ignored `.env` and local Compose files as needed.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SHIFTER_CREDENTIALS_FILE` | Mock fixture path in the example | Host-side path mounted as the live gateway secret |
| `SHIFTER_REGION` | `blr` | Explicit Shifter ingress region |
| `SESSION_SECONDS` | `600` | Daily browsing window, maximum 600 seconds |
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
| `APP_ENV` | `development` or `test` | Development uses real Shifter; test uses the synthetic upstream. Other values, including `production`, are rejected. |
| `ROLE` | `api` or `gateway` | Binary role |
| `REPLICA` | `api`, `gateway-a`, `gateway-b` | Operational identity for health/metrics |
| `LISTEN` | `0.0.0.0:3000` | Listener inside the container |
| `REDIS_URL` | `redis://redis:6379/` | Shared session store; mock override selects `/1` |
| `CONTROL_ORIGIN` | `http://localhost:8080` | Exact trusted browser origin |
| `RUNTIME_ORIGIN` | `http://localhost:8081` | Exact runtime/WebSocket origin |
| `CREDENTIALS_FILE` | `/run/secrets/shifter_credentials` | In-container credential path |
| `WEB_DIR` | `/app/web` in Docker | Static asset root |

Supported country codes are `us`, `gb`, `de`, `fr`, `ca`, `au`, `sg`, and `in`. The interface defaults to the United States. Missing or unlisted countries are rejected; country targeting is never silently omitted.

The regional allowlist is `fra`, `ams`, `lon`, `nyc`, `tor`, `sgp`, `blr`, and `syd`. Only the BLR upstream was exercised in the initial live validation.

## Redis security rules

**Redis must run exclusively on private network addresses in every region. Public Redis endpoints and published Redis ports are prohibited.** This applies to primary/replica instances, Sentinel, and cluster management ports.

The permanent project rule is [Redis security rule](.cursor/rules/redis-security.mdc), referenced by [AGENTS.md](AGENTS.md). It applies to application, infrastructure, example configuration, and operational changes.

The local Compose example attaches Redis only to `session_state`, a bridge network with `internal: true` and `isolated` gateway mode for IPv4 and IPv6. The API and both gateways join that network and the separate default network. HAProxy and the synthetic destination stay off the state network. Redis publishes no host port, including loopback port mappings. Its `6379/tcp` image metadata in `docker compose ps` is not a published host listener; any `HOST:PORT->6379` mapping would violate the rule. Docker host administrators retain privileged access to container networks; this isolation does not defend against a compromised host or Docker administrator.

The explicit bridge mode is required: on the development device, `internal: true` alone still allowed a direct connection from HAProxy to Redis. With `isolated` mode, the deployed-container check confirms that the API and both gateways can use Redis while HAProxy cannot connect to its private port. Run this check on each deployment engine; do not remove the isolation options to work around an unsupported engine.

For an existing checkout, `scripts/configure.sh` preserves local files. Merge the network changes from `compose.example.yaml` into your ignored `compose.yaml`, then recreate this project’s containers and networks with `docker compose down` followed by your usual stack start command. Do not pass `--volumes`: the Redis data volume must survive. This interrupts active local browsing connections.

Production requirements:

- Private IPs and private DNS only; no public IP, public load balancer, public DNS endpoint, NAT/port forwarding, or host-network shortcut for Redis.
- Bind Redis only to private interfaces and necessary loopback addresses. Firewall/security groups deny access by default, allowing the regional API/gateways and explicitly approved private administration, monitoring, and replication peers.
- Require named ACL users with least-privilege key and command permissions; disable unauthenticated default access. Keep protected mode enabled.
- Require TLS with certificate and hostname verification for client and replication connections. Authentication complements private networking; it does not replace it.
- Keep credentials, ACL material, certificates, private keys, and actual regional configuration in secret storage or ignored local files. Do not log authenticated Redis URLs.
- Continue failing closed when authorization or quota storage is unavailable.

The local configuration uses unauthenticated, non-TLS Redis **only inside its isolated Docker state network**. Production remains disabled. The current Rust Redis dependency/configuration is not a ready-made production TLS/ACL integration; implement and validate it before production is enabled. Network isolation alone must not be described as complete production hardening.

Run the policy rejection checks and the deployed-container checks after networking changes:

```sh
node --test tests/redis-network-policy.test.mjs
node tests/configuration.mjs
```

The configuration check rejects Redis host port mappings, host networking, non-internal networks, missing isolated bridge modes, non-private assigned IPs, and unexpected state-network members. It also confirms application Redis access and requires a direct connection attempt from HAProxy to fail. These are local Docker checks; actual cloud firewall rules, private endpoint settings, ACLs, certificates, and regional replication access require deployment-specific verification.

These requirements follow the [Redis security guidance](https://redis.io/docs/latest/operate/oss_and_stack/management/security/) and [Docker Compose internal network configuration](https://docs.docker.com/reference/compose-file/networks/#internal), and [Docker isolated gateway mode](https://docs.docker.com/engine/network/port-publishing/#gateway-modes).

## Session lifecycle and limits

### Identity and daily allowance

The local visitor identity is an opaque first-party cookie named `shifter_dev`, with HttpOnly and SameSite=Strict attributes. This is a development identity, not verified anti-abuse identity. Deleting/replacing cookies can create another visitor; the current service must not be exposed as a public free proxy.

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

The trusted controls and proxied content use separate local origins. The runtime owns Scramjet, its service worker, a bare-mux SharedWorker, and the Epoxy transport. A nested frame displays the destination website.

The runtime attempts to clear local/session storage, service-worker registrations, caches, and IndexedDB stores on Stop, country change, and expiry. Cleanup is attempted before starting the next runtime after an interrupted session. This is a cleanup lifecycle, not a forensic erasure guarantee. Backend expiry remains effective when browser cleanup does not run.

The browser integration implements HTML navigation, JavaScript network requests, forms, redirects, and cookie handling through the engine. Compatibility is site-dependent. The observed fixture login/navigation flow is not evidence that every public website, OAuth flow, payment flow, WebAuthn flow, or browser feature will work.

Security-sensitive boundaries include exact Origin checks, postMessage source checks, no upstream credentials in browser code, and a separate trusted control origin. Scramjet’s emulated destination origins are not equivalent to separate browser-enforced origins for every destination; the engine and its isolation need further adversarial review before public deployment.

Production proxied content must use a separate registrable domain from trusted Shifter pages. Changing only the port is a local test arrangement. Production transport-origin routing, HTTPS/WSS, and certificate management are future work.

## API reference

The session API is on the control origin. Mutation requests require its exact Origin header. The browser supplies the development cookie automatically. JSON bodies use `Content-Type: application/json`; the API body limit is 1 KiB.

| Method and path | Body | Purpose |
| --- | --- | --- |
| `GET /api/countries` | None | Configured codes/names, runtime origin, development/test flags |
| `POST /api/sessions` | `{"country":"us"}` | Create or resume the visitor’s daily session |
| `GET /api/session` | None | Public session status and remaining allowance |
| `POST /api/session/tickets` | None | Issue a single-use Wisp authorization valid for 30 seconds |
| `POST /api/session/country` | `{"country":"de"}` | Revoke the current assignment and select a new country |
| `POST /api/session/reconnect` | None | Revoke the old connection revision while preserving SID and allowance |
| `DELETE /api/session` | None | Stop active access |

A session response includes `country`, `status`, `serverTime`, `expiresAt`, `remainingBytes`, `byteLimit`, `connected`, and `developmentIdentity`. Times are Unix milliseconds. Status is `active`, `stopped`, `expired`, or `exhausted`. Upstream credentials and the upstream SID are not returned.

The Wisp endpoint is on the runtime origin:

```text
ws://localhost:8081/wisp/?ticket=<single-use-ticket>
ws://localhost:8081/wisp/<single-use-ticket>/
```

Protocol tests use the query form; the browser transport uses the path form. Both require a valid ticket and the exact runtime Origin. Tickets are sensitive short-lived authorization values; do not add URL/access logging that records them.

Additional endpoints:

| Endpoint | Availability | Purpose |
| --- | --- | --- |
| `GET /health` | API and gateways | Redis-backed readiness check |
| `GET /metrics` | API and gateways | JSON counters: replica, connections, streams, accepted, rejected, bytes up/down |
| `GET /settings` | Gateways | Trusted control origin for runtime messaging |

Invalid Origins or malformed ticket syntax are denied; missing/inactive sessions, reused tickets, ownership conflicts, and expired allowances are denied. Redis failures prevent authorization. HTTP error details are intentionally limited; Wisp ticket claim failures do not expose account or session internals.

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
customer-<account>-country-<country>-strict-true-sid-<128-bit-random-hex>-ttl-600-pool-shifter
```

The final `pool-shifter` flag restricts upstream assignments to the Shifter pool. The gateway always adds it server-side; visitors cannot choose or override the pool.

Account syntax and SOCKS5 credential lengths are validated. Authentication failures do not trigger a direct-connect fallback. Authenticated upstream sockets are not shared between sessions.

The destination policy rejects private/reserved IPv4/IPv6 ranges, loopback, link-local, multicast, mapped/translation ranges, local/internal names, Shifter infrastructure hostnames, and the configured upstream’s resolved addresses. DNS answers containing a blocked address are rejected rather than selecting a different answer. Connecting to the validated IP prevents a second, unchecked destination DNS lookup by the upstream proxy.

The destination’s original TLS hostname remains available to the browser transport. The live Node TLS smoke test separately checked opaque TLS forwarding with hostname/certificate verification enabled; it does not validate production frontend certificates or browser-wide compatibility.

The reserved `fixture.test` and `second.test` mappings exist only in test mode. The synthetic SOCKS server serves fixture responses without opening destination Internet connections.

## HAProxy, regions, and recovery

HAProxy runs in TCP mode with `leastconn`, backend health checks, Docker DNS resolution, and an eleven-minute connection idle timeout. A gateway sends periodic WebSocket pings. Backend allowance enforcement still ends browsing at its own shorter session deadline.

**HAProxy balances connections, not individual requests inside a Wisp connection.** An established WebSocket remains attached to one replica. Independent visitors and later reconnects may select different replicas.

If a replica stops, in-flight requests fail. The browser must explicitly reconnect; the surviving replica reads shared Redis state and preserves the session’s country, SID, region, and remaining allowance. A crashed replica’s lease may take up to six seconds to expire, in addition to health-check/routing recovery time.

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

The local scan compares exact account/password values against source, generated assets, test evidence, application/HAProxy logs, and image history without printing those values. It supplements review; it does not prove the absence of every possible secret or replace a staged-file audit.

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

The development cookie is not a public anti-abuse control. `APP_ENV=production` is deliberately rejected instead of silently using that identity mode.

## Project layout

```text
src/
  main.rs                     Role selection, routing, headers, process setup
  config.rs                   Validated settings and server-side credential loading
  api.rs                      Session API, trusted controls, health and metrics
  store.rs                    Redis session state, tickets, leases and quotas
  relay.rs                    Wisp adapter, admission, destination policy and SOCKS5
web/
  control/                    Trusted address bar, country selector and session UI
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
- Replace development cookies with verified anti-abuse identity, server-validated CAPTCHA/Fingerprint events, and abuse monitoring.
- Add broader service-level admission controls, operational resource limits, and sustained load testing.
- Separate trusted Shifter pages and untrusted website content onto different registrable domains; review engine isolation and escape risks.
- Configure production HTTPS/WSS, transport-origin routing, certificate handling, and secure cookie policy.
- Enforce the Redis security rules above, including production ACL/TLS support, private endpoints and verified network access restrictions.
- Establish regional Redis/state availability and an explicit cross-region recovery protocol that preserves allowance but rotates residential assignment.
- Deploy regional HAProxy/gateway groups and geographic/latency-aware DNS, with health-aware routing.
- Add production telemetry that protects browsing privacy and excludes credentials, connection tickets, and destination URLs.
- Configure a real VPN download destination and final expired-session UX.

No production DNS changes, public deployment, or remote-device execution are part of this repository’s initial local milestone.

References: [Scramjet](https://github.com/MercuryWorkshop/scramjet), [epoxy-tls and Wisp](https://github.com/MercuryWorkshop/epoxy-tls), [HAProxy TCP configuration](https://www.haproxy.com/documentation/haproxy-configuration-tutorials/protocol-support/tcp/), [Shifter gateway and regions](https://shifter.io/docs/products/residential-proxies/gateway-and-auth/), [Shifter geo-targeting](https://shifter.io/docs/products/residential-proxies/geo-targeting/), and [Shifter sessions](https://shifter.io/docs/products/residential-proxies/sessions/).
