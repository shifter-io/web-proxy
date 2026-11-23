# Cap cutover and rollback

The current stable loader remains on SDK 1.0.10. SDK 1.0.12 refreshes the
CAPTCHA config before each new session. An isolated canary can load its
versioned client explicitly without changing the shared production loader.

## Isolated staging overlays

Both overlays target a staging stack that is not in this repository. They
apply only to a project whose services are named exactly `api` and `gateway`
and whose API already runs Cap: `CAPTCHA_PROVIDER=cap`, `CAP_SITES_FILE`,
`CAP_PUBLIC_URL`, `CAP_VERIFY_URL` and an `INTEGRATIONS` list matching the Cap
sites. They do not apply to this folder's `compose.example.yaml` (API only, Cap
pilot) or to the root Compose files (`gateway-a`/`gateway-b`): merged there,
the candidate overlay creates a new, unconfigured `gateway` service, and the
dual overlay makes the API refuse to start because `CAPTCHA_ACCEPT_BOTH=true`
requires those Cap settings. Check `docker compose config --services` lists
only the existing services before `up`.

`candidate.compose.example.yaml` can be merged with an existing staging stack
to replace only the API and gateway image and bind a staging-only stable loader.
Set `CAP_STAGING_IMAGE` to the pinned image and `CAP_STAGING_LOADER` to an
absolute file path outside the image. Copy the release's stable loader and
change only its release pointer to `1.0.12` for this staging file. Do not modify
the production loader or immutable release assets. Preserve the existing
Compose project name; validate the merged configuration before using
`up -d --no-deps api gateway`. Redis and the Cap verifier are not redeployed.

Use `dual.compose.example.yaml` only after provisioning real staging reCAPTCHA
v2 checkbox credentials authorized for the embedding hostname. Supply
`CAP_STAGING_PROVIDER`, `CAP_STAGING_RECAPTCHA_SITE_KEY` and
`CAP_STAGING_RECAPTCHA_SECRET_FILE` in a protected environment. The mounted
secret must be readable by the API UID; it is not mounted into the gateway.
Never use Google's public test keys or production secrets for this test.

Retain the old image and Compose configuration before the canary. Verify both
containers' image revision, health, immutable SDK file hashes, rejected fake
tokens and disallowed origins. Then use the actual staging browser flow to
verify Cap, token replay rejection, reCAPTCHA, and a provider-only rollback.
An HTTP health check or mocked verifier is not proof of that browser flow.

The production transition below remains gated on these checks; missing real
staging reCAPTCHA credentials means the rollback gate is not yet complete.

## Production transition

1. Publish and deploy the candidate image with `CAPTCHA_PROVIDER=recaptcha`
   (the default), retaining old SDK assets. On **each** API and gateway
   replica, check that the new release manifest, `client.js` and `captcha.js`
   return 200 under `/sdk/releases/1.0.12/` and match the manifest's SHA-256
   values. A successful request to the public load balancer alone is not
   proof that every replica has the assets.
2. Promote the stable loader in a separate release only after that check
   passes everywhere. Verify session creation with reCAPTCHA first.
3. Prepare a dedicated Cap service with a site key for every configured
   integration entry and verify an isolated canary end to end. Wildcard
   entries share a key within that pattern. Only widget assets, challenge
   and redeem routes should be public. Keep siteverify and admin private.
4. Set `CAPTCHA_ACCEPT_BOTH=true` on **every session API** while leaving
   `CAPTCHA_PROVIDER=recaptcha`. Retain the reCAPTCHA credentials and supply
   `CAP_PUBLIC_URL`, `CAP_VERIFY_URL` and the mounted, API-only
   `CAP_SITES_FILE`. Do not advertise Cap until both verifiers are confirmed
   working on every API that can receive requests on the shared hostname.
5. Switch the advertised provider to `CAPTCHA_PROVIDER=cap` in the canary
   region first; retain `CAPTCHA_ACCEPT_BOTH=true`. Confirm new SDK clients
   get Cap, older SDKs continue to get reCAPTCHA, and each provider can still
   create sessions across both configurations. Test the actual browse path,
   replay rejection and rollback before advancing other regions.

**Rollback:** set `CAPTCHA_PROVIDER=recaptcha` on the affected APIs, leaving
dual verification enabled while in-flight Cap challenges drain. Keep the
current images and SDK assets in place; do not roll back to an image that drops
the published assets. Roll back the stable loader only if the SDK itself is
the problem, and keep both immutable releases available. Turn off dual
verification only after the transition window and after verifying the effect
on older clients. Cap-only mode requires a Cap-capable client.
