# The Redis image of the store tests: the one pin, sourced by tests/allowance-redis.sh, the ciod hook
# .github/ciod/prefetch.sh and .github/scripts/ci-run.sh. Change the digest only here.
# The index digest names every platform; the hook verifies each body against it and keeps the
# linux/amd64 manifest (sha256:ca0acbb137c1...).
# shellcheck shell=sh disable=SC2034
REDIS_INDEX_DIGEST=sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499
REDIS_TAG=7.4-alpine
REDIS_REPO_HUB=library/redis
REDIS_REPO_MIRROR=docker/library/redis
# The archive the hook writes under $CI_CACHE_DIR/web-proxy/tools, and the local name it loads as
# (never pushed anywhere).
REDIS_ARCHIVE_NAME="redis-${REDIS_INDEX_DIGEST#sha256:}.tar"
REDIS_LOCAL_IMAGE="web-proxy-ci/redis:$REDIS_TAG"
