#!/usr/bin/env bash
# codex 플러그인(openai/codex-plugin-cc)의 companion 스크립트를 찾아 리뷰를 실행한다.
#
# 사용법:
#   bash run-codex.sh [adversarial-review|review] [옵션...] [포커스 텍스트]
#
# 기본 모드는 adversarial-review. 범위는 커밋되지 않은 변경이 있으면 작업 트리, 없으면 마지막 리뷰 지점..HEAD다.
# --base나 --scope를 직접 주면 그 값을 우선한다.
# 리뷰 원문은 stdout과 <저장소 루트>/.claude/review-logs/<시각>-<HEAD 단축 sha>.md에 남는다 (REVIEW_LOG_DIR로 변경 가능).
set -euo pipefail

if ! command -v codex >/dev/null 2>&1; then
    echo "codex CLI를 찾을 수 없습니다. 'npm install -g @openai/codex' 설치 후 /codex:setup 을 실행하세요." >&2
    exit 127
fi

# 어느 마켓플레이스 이름으로 설치했든 찾을 수 있도록 캐시 전체에서 최신 버전을 고른다.
PLUGIN_CACHE="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/plugins/cache"
COMPANION="$(
    for f in "${PLUGIN_CACHE}"/*/codex/*/scripts/codex-companion.mjs; do
        if [[ -f "${f}" ]]; then
            printf '%s\t%s\n' "$(basename "$(dirname "$(dirname "${f}")")")" "${f}"
        fi
    done | sort -V | tail -1 | cut -f2-
)"

if [[ -z "${COMPANION}" ]]; then
    echo "codex 플러그인을 찾을 수 없습니다 (${PLUGIN_CACHE}/*/codex/*/scripts/codex-companion.mjs)." >&2
    echo "'/plugin marketplace add openai/codex-plugin-cc' 후 '/plugin install codex@openai-codex' 로 설치하세요." >&2
    exit 127
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "${REPO_ROOT}"

MODE="adversarial-review"
if [[ $# -gt 0 && "$1" != -* ]]; then
    MODE="$1"
    shift
fi

HAS_TARGET=0
for arg in "$@"; do
    case "${arg}" in
        --base|--base=*|--scope|--scope=*) HAS_TARGET=1 ;;
    esac
done

# 범위를 직접 주지 않았으면:
# - 커밋되지 않은 변경이 있으면 작업 트리(staged + unstaged + untracked)를 리뷰한다. 커밋 전에 리뷰하는 기본 흐름이다.
# - 작업 트리가 깨끗하면 마지막 리뷰 지점(없으면 첫 커밋)부터 HEAD까지의 커밋을 리뷰한다.
EXTRA=()
if [[ "${HAS_TARGET}" -eq 0 ]]; then
    if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
        EXTRA=(--scope working-tree)
    else
        BASE="$(git rev-parse -q --verify refs/codex-review/last || git rev-list --max-parents=0 HEAD | tail -1)"
        EXTRA=(--base "${BASE}")
    fi
fi

LOG_DIR="${REVIEW_LOG_DIR:-${REPO_ROOT}/.claude/review-logs}"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD 2>/dev/null || echo initial).md"

if ! git check-ignore -q "${LOG_FILE}" 2>/dev/null; then
    echo "참고: ${LOG_DIR#"${REPO_ROOT}"/}/ 가 .gitignore에 없습니다. 리뷰 로그가 커밋되지 않게 추가를 권장합니다." >&2
fi

# pipefail로 companion의 종료 코드를 보존한다.
node "${COMPANION}" "${MODE}" --wait ${EXTRA[@]+"${EXTRA[@]}"} "$@" | tee "${LOG_FILE}"
