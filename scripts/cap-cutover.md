# Native production Cap transition

These helpers operate the existing native `web-proxy-api` and
`web-proxy-gateway` systemd services. They do not deploy containers, alter
HAProxy, change DNS, or restart Redis. Run the controller on management using
the current project/tag-scoped web inventory and strict SSH host verification.
Credentials are read from a protected management file and sent over SSH stdin,
never in arguments or reports. The secret file is readable only by root and
the API group; it is not added to the gateway environment.

## Preconditions

- The exact application commit and complete immutable SDK 1.0.12 assets are
  already deployed on every API and gateway replica.
- Every integration has a separate valid Cap site mapping in the protected
  sites file. Retain existing real reCAPTCHA credentials.
- Cap's HTTPS verifier is restricted by both firewall and reverse proxy to
  the exact API egress addresses. Public widget/challenge routes remain public;
  admin, health, and siteverify must not be public.
- Validate a real SDK 1.0.12 reCAPTCHA session, then a Cap canary session and
  replay rejection. Validate provider rollback with both real token types.
  Health checks and fake-token rejection alone do not establish these gates.

## Phases

Pass these required options using your protected deployment environment:

```sh
python3 /root/cap-cutover.py \
  --inventory "$WEB_INVENTORY" --sites-file "$CAP_SITES_FILE" \
  --identity "$FLEET_SSH_IDENTITY" \
  --expected-project "$PROJECT_ID" --expected-tag "$DEPLOYMENT_TAG" \
  --commit "$DEPLOYED_COMMIT" --report "$UNIQUE_REPORT_PATH" \
  --public-url "$CAP_PUBLIC_URL" --verify-url "$CAP_VERIFY_URL" \
  --phase prepare --host "$CANARY_HOST"
```

Without `--apply`, the command audits only. Use unique report paths for every
invocation. `--host` and `--region` narrow targets; omitting both selects every
web application node, not the HAProxy or Redis hosts. Use `--workers 1` for
rolling changes without restarting every replica in a region together.

1. Apply `prepare` to the canary, verify it, then all APIs. This installs an
   additive `90-cap-transition.conf` drop-in and sets reCAPTCHA preferred,
   dual verification enabled. Only the API restarts. All six origin mappings
   must match exactly. Authenticated TLS fake-token rejection is checked before
   service settings change. Keep the gateway PID unchanged.
2. Apply `enable` to a canary. This first audits **all** APIs for dual verification,
   even when targeting one host. New clients asking `?captcha=cap` receive Cap;
   older clients without that capability still receive reCAPTCHA. Complete the
   real solve/replay/provider-rollback gates before enabling remaining regions.
3. Apply `loader` to a canary, then regionally with one worker. It creates a
   derivative of the current release, modifies only the stable loader pointer
   to 1.0.12 (plus build metadata/checksums), retains immutable releases and
   switches atomically. API and gateway restart to use the new working directory.
   The source release remains untouched. Verify the served loader and immutable
   assets after each promotion; repeat a real public browsing test.

The controller checks exact HAProxy backend membership and all backend states
after each region. A failed check stops advancement. In-flight operations within
the selected region complete and are recorded. A transport timeout has an
uncertain outcome: inspect the node before retrying. Do not blindly repeat it.

## Rollback and persistence

Use the same invocation with `--phase rollback --apply` to advertise reCAPTCHA
again while retaining both verifiers. This does not require Cap to be reachable,
does not remove the new SDK assets, and does not restart the gateway. Keep dual
verification enabled while existing Cap challenges drain. Never revert to an
old binary that cannot validate already-issued Cap tokens.

Node transaction records and previous configuration are in
`/root/shifter-web-backups/cap-*`. On a local activation/check failure, the helper
restores the prior provider configuration or release link and verifies services.
On a pre-activation rejection, it does not restart a service. Do not delete
rollback artifacts as part of this procedure.

The persistent API configuration is `/etc/web-proxy/cap-transition.env` plus
the systemd drop-in; ordinary restart retains it. The source stable loader must
also be promoted in the repository so future application updates do not silently
restore 1.0.10. Deployment is not evidence that the repository PR has merged.
