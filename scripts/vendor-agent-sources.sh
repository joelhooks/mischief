#!/usr/bin/env bash
# Vendor shallow git source mirrors under .agent_sources/github.com/<owner>/<repo>.
# Reference-only — never a runtime dependency. Refresh: ./scripts/vendor-agent-sources.sh --refresh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${ROOT}/.agent_sources/github.com"
REFRESH=false

for arg in "$@"; do
  case "$arg" in
    --refresh) REFRESH=true ;;
    -h | --help)
      echo "Usage: $0 [--refresh]"
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg" >&2
      exit 1
      ;;
  esac
done

clone_source() {
  local owner="$1" repo="$2" remote="$3" ref="$4" note="${5:-}"
  local dest="${PREFIX}/${owner}/${repo}"
  local metadata="${dest}/.agent-source.json"
  local commit=""

  if [[ -d "${dest}/.git" ]]; then
    if [[ "$REFRESH" != true ]]; then
      echo "skip ${owner}/${repo} (exists; pass --refresh to replace)"
      return 0
    fi
    rm -rf "$dest"
  elif [[ -e "$dest" ]]; then
    rm -rf "$dest"
  fi

  mkdir -p "$(dirname "$dest")"
  echo "clone ${owner}/${repo} @ ${ref}"
  git clone --depth 1 --branch "$ref" "$remote" "$dest"
  commit="$(git -C "$dest" rev-parse HEAD)"

  cat >"$metadata" <<EOF
{
  "type": "github-repo-source",
  "owner": "${owner}",
  "repo": "${repo}",
  "remote": "${remote}",
  "ref": "${ref}",
  "commit": "${commit}",
  "addedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "note": "${note:-Project-local shallow git source mirror. Refresh: ./scripts/vendor-agent-sources.sh --refresh}"
}
EOF

  echo "  -> ${dest} (${commit})"
}

# Core fleet libs only. Product-specific mirrors (e.g. x-algorithm) belong in the consuming app.
# Refs are derived from the workspace pins so a bump in package.json is a bump here.
# effect-smol is archived: V4 lives in Effect-TS/effect only.
pin() {
  node -p "require('${ROOT}/$1').dependencies['$2']"
}
EFFECT_VERSION="$(pin packages/core/package.json effect)"
XSTATE_VERSION="$(pin packages/core/package.json xstate)"
XSTATE_EFFECT_VERSION="$(pin packages/core/package.json @xstate/effect)"
XSTATE_EFFECT_REF="@xstate/effect@${XSTATE_EFFECT_VERSION}"
XSTATE_REF="xstate@${XSTATE_VERSION}"

if ! git ls-remote --exit-code --refs https://github.com/statelyai/xstate.git "refs/tags/${XSTATE_EFFECT_REF}" >/dev/null; then
  echo "Cannot resolve required ${XSTATE_EFFECT_REF}; refusing a core-tag fallback." >&2
  exit 1
fi
ALCHEMY_VERSION="$(pin apps/infra/package.json alchemy)"

clone_source Effect-TS effect https://github.com/Effect-TS/effect.git "effect@${EFFECT_VERSION}" \
  "Effect v4 monorepo matching packages/core effect@${EFFECT_VERSION}."
clone_source kitlangton effect-solutions https://github.com/kitlangton/effect-solutions.git main \
  "Idiomatic Effect patterns guide (Kit Langton)."
clone_source statelyai xstate https://github.com/statelyai/xstate.git "${XSTATE_REF}" \
  "XState core matching packages/core xstate@${XSTATE_VERSION}; bridge source must match @xstate/effect@${XSTATE_EFFECT_VERSION} exactly."

git -C "${PREFIX}/statelyai/xstate" fetch --depth 1 origin \
  "refs/tags/${XSTATE_EFFECT_REF}:refs/tags/${XSTATE_EFFECT_REF}"
SOURCE_BRIDGE_TREE="$(git -C "${PREFIX}/statelyai/xstate" rev-parse HEAD:packages/xstate-effect)"
PINNED_BRIDGE_TREE="$(git -C "${PREFIX}/statelyai/xstate" rev-parse "${XSTATE_EFFECT_REF}:packages/xstate-effect")"
if [[ "$SOURCE_BRIDGE_TREE" != "$PINNED_BRIDGE_TREE" ]]; then
  echo "XState core ${XSTATE_REF} does not contain the exact ${XSTATE_EFFECT_REF} bridge tree; refusing mismatched source." >&2
  exit 1
fi

SOURCE_XSTATE_VERSION="$(node -p "require('${PREFIX}/statelyai/xstate/packages/core/package.json').version")"
SOURCE_XSTATE_EFFECT_VERSION="$(node -p "require('${PREFIX}/statelyai/xstate/packages/xstate-effect/package.json').version")"
if [[ "$SOURCE_XSTATE_VERSION" != "$XSTATE_VERSION" || "$SOURCE_XSTATE_EFFECT_VERSION" != "$XSTATE_EFFECT_VERSION" ]]; then
  echo "XState source versions do not match both pins; refresh ${XSTATE_EFFECT_REF}." >&2
  exit 1
fi
clone_source alchemy-run alchemy https://github.com/alchemy-run/alchemy.git "v${ALCHEMY_VERSION}" \
  "Alchemy IaC matching apps/infra alchemy@${ALCHEMY_VERSION}. Read alchemy/src/ and cloudflare/src/."

echo "done — agent sources under ${PREFIX}"
