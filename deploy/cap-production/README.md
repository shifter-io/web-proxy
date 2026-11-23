# Dedicated production Cap host

These examples install only the verifier infrastructure, not a web-proxy fleet
rollout or provider switch. Follow the staged gates in
`../cap-staging/rollout.md` before advertising Cap to customers.

## Installation

Use a dedicated Ubuntu 24.04 host with Docker Engine/Compose v2, OpenSSL,
Python 3 and Caddy. Place these templates outside the deployment directory.
Run `python3 initialize.example.py /opt/shifter-cap-prod` as root. Initialization
requires an empty destination and refuses to rotate or overwrite credentials.
It creates root-only Cap credentials, a named storage ACL user, a private CA,
and a TLS certificate for the internal `valkey` hostname.

From the generated directory, run `docker compose config --quiet`, then
`docker compose up -d --wait --wait-timeout 120`. Verify both containers are
healthy and `curl -fsS http://127.0.0.1:13000/health` succeeds. Storage must have
no published port, an internal isolated Docker network, and disabled default
user. Plaintext storage is disabled. Validate both unauthenticated rejection
and TLS rejection for the wrong hostname. Do not disable certificate checks.

Use the loopback-only Cap administration API (or an authenticated SSH tunnel)
to generate distinct site keys for every integration origin/pattern. Preserve
the resulting secret mapping in root-only storage; expose it only to web-proxy
API processes, never gateways, browsers, images, Git, or logs. Configure each
key's CORS origins, enable locally served widget assets, and configure Cap to
trust the ingress proxy's `X-Forwarded-For` header. Caddy replaces that header
with the connection peer. No direct public Cap container access is permitted.

## Ingress

Set `CAP_PUBLIC_HOST` and `CAP_VERIFY_ALLOWLIST` in a protected Caddy service
environment file. The latter is a space-separated list of exact, verified API
egress IPs/CIDRs, not a regional subnet or `0.0.0.0/0`. Validate the example
Caddyfile before installing it. Point the new hostname's DNS A record at this
host; preserve unrelated records. Caddy issues/renews its public certificate.

- Public TCP 443: assets and challenge/redeem only; dashboard, siteverify and
  health return 404. TCP 80 serves ACME and HTTPS redirects.
- TCP 8443: HTTPS siteverify only, restricted by both firewall and Caddy to the
  exact API egress allowlist. This is source-restricted public-IP transport,
  **not** a cross-region private VPC. Never allow it globally.
- Administration: loopback 13000 only, through trusted SSH with the Cap admin
  credential. Neither public listener exposes admin routes.
- SSH: retain only approved operator/management source IPs; verify a second
  connection before removing bootstrap access. Verify SSH host identity.
- Valkey: no host-published port, internal Docker network only. Docker loopback
  publication of Cap cannot be broadened; UFW alone does not protect Docker
  published ports.

Check the site's correct and incorrect origins independently. Cap suppresses
CORS permission for a wrong origin; it does not necessarily return HTTP 403.
The web-proxy API must still enforce its integration allowlist. An invalid
token must fail verification; malformed input can return 400 and nonexistent
tokens 404. Do not interpret a successful challenge fetch as a solved CAPTCHA.

## Maintenance and rollback

Images are digest-pinned. Logs rotate at 10 MB x 3 per container. Storage uses
AOF with fsync every second and noeviction. Enable host memory overcommit for
Valkey background saves. Inspect CPU/RAM and storage under real traffic before
claiming capacity. Back up Cap secrets, the private CA, configuration, and
consistent Valkey persistence separately in protected storage. Restore-test
before promising recoverability; keep service credentials out of backups that
are shared with developers. Track certificate expiry: the private storage
certificate is valid for 825 days and requires planned renewal (it is not
renewed by Caddy). Public certificate renewal is Caddy-managed.

For upgrades, retain the old image/configuration and storage backup, validate
the candidate, then replace only Cap/Valkey as intended. `docker compose down
-v` is not a rollback. A provider rollback on web-proxy should preserve both
immutable SDK releases and dual verification while in-flight challenges drain;
it must not delete Cap's keys or state.

Local checks: `python3 -m unittest discover -s deploy/cap-production -p
'test_*.py'`, existing Redis policy tests, and live Compose/Caddy validation.

## Isolated staging verification

`staging-verifier.compose.example.yaml` changes only the existing isolated
staging API's Cap endpoints and secret mount. Set `CAP_PROD_PUBLIC_URL`,
`CAP_PROD_VERIFY_URL`, and `CAP_PROD_STAGING_SITES_FILE`; the latter must contain
only the staging origin's mapping and be readable by the API service UID.
Append this overlay after the staging base and candidate overlays, validate
with `config --quiet`, then recreate **only** `api` with `--no-deps --wait`.
Do not recreate the gateway, Redis, or existing staging Cap containers.

Allow the exact staging egress address on the restricted verifier listener
before this test. Check API health, correct-origin challenge delivery, and
invalid-token rejection without logging secrets. Complete an authorized real
browser solve, browsing, replay rejection, and reCAPTCHA rollback test before
promoting the customer fleet. To restore the original staging verifier, omit
this last overlay while retaining the same base/candidate overlays and recreate
only `api`. Keep the original staging secret mapping untouched.
