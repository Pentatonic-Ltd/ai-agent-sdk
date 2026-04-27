#!/usr/bin/env bash
#
# Pentatonic Memory manual-test rig — minimal version.
#
# Two commands drop you into a fresh agent container:
#
#   ./manual-test.sh claude       — Claude Code in Docker
#   ./manual-test.sh openclaw     — OpenClaw in Docker
#
# State (auth, plugin cache, configs) lives in named volumes that survive
# container restarts. Wipe them with:
#
#   ./manual-test.sh reset claude
#   ./manual-test.sh reset openclaw
#   ./manual-test.sh reset all
#
# Everything else — installing the plugin, configuring tes-memory.local.md,
# running test prompts — happens manually inside the container.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_DIR="$SCRIPT_DIR/docker"

CLAUDE_IMAGE="pentatonic-manual-test-claude"
CLAUDE_VOLUME="manual-test-claude"
CLAUDE_CONTAINER="manual-test-claude"

OPENCLAW_IMAGE="pentatonic-manual-test-openclaw"
OPENCLAW_VOLUME="manual-test-openclaw"
OPENCLAW_CONTAINER="manual-test-openclaw"

usage() {
  cat <<EOF
Usage: $0 <command>

Commands:
  claude              Drop into a Claude Code container (volume: $CLAUDE_VOLUME)
  openclaw            Drop into an OpenClaw container (volume: $OPENCLAW_VOLUME)
  reset claude        Wipe Claude Code state (auth, plugins, config)
  reset openclaw      Wipe OpenClaw state
  reset all           Wipe both
  status              Show volumes and any running containers
  help

Optional env (passed through if set):
  ANTHROPIC_API_KEY   Skips Claude Code OAuth flow
  OPENROUTER_API_KEY  OpenClaw chat backend
  TES_ENDPOINT, TES_CLIENT_ID, TES_API_KEY  For testing against remote TES

Notes:
  • Containers run with --network=host so they can reach a memory server
    you start on the host (e.g. \`npx @pentatonic-ai/ai-agent-sdk memory\`).
  • State persists across runs until you 'reset'. The first invocation
    builds the image (~30s for claude, slower if openclaw image cold).
  • Your host \`~/.claude\` and \`~/.openclaw\` are NOT touched.

Examples:
  $0 claude                        # build if needed, drop into container
  $0 reset claude && $0 claude    # fresh start
EOF
}

log()  { printf "\033[1;36m[manual-test]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[manual-test]\033[0m %s\n" "$*" >&2; }
fail() { printf "\033[1;31m[manual-test]\033[0m %s\n" "$*" >&2; exit 1; }

# Build an image only when missing or its Dockerfile is newer than the
# image. Cheap; first run builds, subsequent runs reuse.
build_if_needed() {
  local image="$1" dockerfile="$2"
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    log "building $image (first run)..."
    docker build -t "$image" -f "$dockerfile" "$DOCKER_DIR"
  fi
}

# Run a fresh interactive container. We use --rm so the container goes
# away on exit; persistence comes from the named volume mounted at the
# config dir. Re-running the command starts a NEW container with the
# SAME state.
run_claude() {
  build_if_needed "$CLAUDE_IMAGE" "$DOCKER_DIR/Dockerfile.claude-code"
  log "starting Claude Code container (volume: $CLAUDE_VOLUME)..."
  docker run --rm -it \
    --name "$CLAUDE_CONTAINER" \
    --network=host \
    -e "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}" \
    -e "TES_ENDPOINT=${TES_ENDPOINT:-}" \
    -e "TES_CLIENT_ID=${TES_CLIENT_ID:-}" \
    -e "TES_API_KEY=${TES_API_KEY:-}" \
    -v "${CLAUDE_VOLUME}:/root/.claude" \
    "$CLAUDE_IMAGE"
}

run_openclaw() {
  build_if_needed "$OPENCLAW_IMAGE" "$DOCKER_DIR/Dockerfile.openclaw"
  log "starting OpenClaw container (volume: $OPENCLAW_VOLUME)..."
  docker run --rm -it \
    --name "$OPENCLAW_CONTAINER" \
    --network=host \
    -e "OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-}" \
    -e "TES_ENDPOINT=${TES_ENDPOINT:-}" \
    -e "TES_CLIENT_ID=${TES_CLIENT_ID:-}" \
    -e "TES_API_KEY=${TES_API_KEY:-}" \
    -v "${OPENCLAW_VOLUME}:/home/node/.openclaw" \
    "$OPENCLAW_IMAGE"
}

reset_volume() {
  local label="$1" volume="$2"
  if ! docker volume inspect "$volume" >/dev/null 2>&1; then
    log "$label state already empty (no volume $volume)"
    return
  fi
  warn "wiping $label state (volume: $volume)"
  read -r -p "[manual-test] continue? [y/N] " ans
  [[ "$ans" =~ ^[yY]$ ]] || { log "aborted."; return; }
  docker volume rm -f "$volume" >/dev/null
  log "$label state cleared."
}

reset() {
  case "${1:-}" in
    claude)   reset_volume "Claude Code" "$CLAUDE_VOLUME" ;;
    openclaw) reset_volume "OpenClaw"    "$OPENCLAW_VOLUME" ;;
    all)
      reset_volume "Claude Code" "$CLAUDE_VOLUME"
      reset_volume "OpenClaw"    "$OPENCLAW_VOLUME"
      ;;
    *) fail "reset target required: claude | openclaw | all" ;;
  esac
}

show_status() {
  echo "Images:"
  docker image ls --filter "reference=pentatonic-manual-test-*" \
    --format 'table {{.Repository}}\t{{.Tag}}\t{{.Size}}'
  echo
  echo "Volumes:"
  docker volume ls --filter "name=manual-test-" \
    --format 'table {{.Name}}\t{{.Driver}}'
  echo
  echo "Running containers:"
  docker ps --filter "name=manual-test-" \
    --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' || true
}

case "${1:-help}" in
  claude)   run_claude ;;
  openclaw) run_openclaw ;;
  reset)    shift; reset "$@" ;;
  status)   show_status ;;
  help|-h|--help) usage ;;
  *) usage; exit 1 ;;
esac
