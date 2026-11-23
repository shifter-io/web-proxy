# Cap cutover and rollback

The current stable loader remains on SDK 1.0.10. SDK 1.0.12 refreshes the
CAPTCHA config before each new session. An isolated canary can load its
versioned client explicitly without changing the shared production loader.

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
