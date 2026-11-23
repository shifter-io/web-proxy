# Native release rollout, Cap disabled

These optional tools target the existing native systemd deployment, not Docker
application hosts. They never rewrite `/etc/web-proxy`, load Cap secrets, change
Redis, change HAProxy, or promote the stable SDK loader. Application services
are restarted; active connections on each restarted gateway can disconnect.

Build the repository's digest-pinned Dockerfile at a reviewed commit, setting
`org.opencontainers.image.revision` to that full commit. Run
`package-native-from-image.sh IMAGE FULL_COMMIT OUTPUT.tar.gz` to extract the
binary and complete web assets, with build metadata and checksums. Use the
filename `web-proxy-release-FULL_COMMIT.tar.gz`. Run relevant source tests first;
packaging alone does not test or attest the image's source provenance.

Place `native-release-node.py` beside `native-release-rollout.py` on management.
Provide the current dedicated inventory, expected project and deployment tag,
an existing SSH identity, a fresh report filename, artifact and full commit:

```sh
python3 native-release-rollout.py \
  --inventory "$INVENTORY" --expected-project "$PROJECT_ID" \
  --expected-tag "$DEPLOYMENT_TAG" --identity "$SSH_IDENTITY" \
  --artifact "$ARTIFACT" --commit "$COMMIT" \
  --workers 8 --report "$NEW_REPORT_PATH"
```

The default is read-only. Add `--apply` to deploy, or `--host HOSTNAME` for one
canary. The controller verifies live hostnames and Droplet metadata IDs, exact
HAProxy inventory membership, backend health, active services and reCAPTCHA
configuration. It relies on a trusted inventory for project/tag membership;
it does not query the DigitalOcean control-plane API. Reconcile that inventory
before using the tool. All SSH host keys must already be verified and known;
unknown/changed keys fail closed.

The first selected node is a canary. Subsequent waves update at most one node
per region, with up to eight regions in parallel. A failed wave stops further
waves; already running peers in that wave finish their checks. Per-node
application/health failures after activation restore the previous release and
restart both services. Transport ambiguity or HAProxy validation failure stops
progress for inspection; it does not guess the remote state or claim rollback.

Existing SDK releases and the stable loader must be byte-identical in the new
package, or deployment stops before activation. Node checks verify both
running binaries, artifact hashes, versioned SDK 1.0.12 assets served by every
API and gateway, unchanged configuration hashes, and reCAPTCHA responses for
every integration with and without `?captcha=cap`. This proves provider
selection, not a real browser reCAPTCHA solve.

The controller does not change the inventory's recorded application commit.
After a complete independently checked rollout, reconcile the inventory and
runbook with the per-node report. Backups store the previous release path and
preflight hashes under `/root/shifter-web-backups/native-TIMESTAMP`; existing
configuration is not modified. Do not remove old releases until rollback is no
longer needed. A pre-activation validation failure can leave a candidate
directory; inspect it before retrying, as existing candidate directories are
deliberately not overwritten.
