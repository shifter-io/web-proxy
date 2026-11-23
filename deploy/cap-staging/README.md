# Cap staging pilot

Run this on a dedicated staging host. It starts Cap, its private Valkey, and a
development-mode copy of the real Shifter session API with a separate private
Redis. There is no gateway or production upstream credential. Production
refuses `CAPTCHA_PROVIDER=cap-staging` and still defaults to reCAPTCHA.

1. Set `CAP_STAGING_HOST` to a new, dedicated DNS name and generate a private
   `CAP_ADMIN_KEY`. Start only `valkey` and `capd` using the example Compose file.
2. Open the Cap dashboard via an SSH tunnel to host loopback port 13000. Create a
   dedicated site key with the single staging origin. Enable self-hosted widget
   files. Set Cap's trusted forwarding mode to X-Forwarded-For; only the local
   ingress proxy and this dedicated host may reach capd.
3. Set `CAP_STAGING_SITE_KEY` and point `CAP_STAGING_SECRET_PATH` at a private
   file readable by API container UID 10001. Start `redis` and `api`. Keep both
   databases on their separate internal networks and never publish their ports.
4. Install the example Caddyfile with the exact host, public site key and
   static page directory substituted. Only the widget assets, challenge,
   redeem, public config and session-creation paths are exposed. The Cap
   admin endpoints and siteverify remain private.
5. Load the staging page in a browser, solve the challenge, create a staging
   session, and confirm the replay check rejects the same token. Also check
   wrong-origin and wrong-site-token rejection. Do not migrate live origins.

This checks the CAPTCHA-to-session flow, not a live Wisp tunnel or a production
browser SDK migration. Store only example settings in Git.
