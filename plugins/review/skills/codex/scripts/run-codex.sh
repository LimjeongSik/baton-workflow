#!/usr/bin/env bash
# codex 플러그인(openai/codex-plugin-cc)의 companion 스크립트를 찾아 리뷰를 실행한다.
#
# 사용법:
#   bash run-codex.sh [adversarial-review|review] [--full] [옵션...] [포커스 텍스트]
#
# 범위를 주지 않으면 아직 리뷰하지 않은 내용만 리뷰한다 (delta.mjs). 이미 리뷰한 파일·줄과 공백만 바뀐 파일은 빠진다.
# 리뷰할 내용이 없으면 codex를 부르지 않고 끝낸다.
# 모드를 주지 않으면 위험도로 고른다: 민감한 변경은 adversarial-review, 그 외는 review.
# --full을 주면 예전처럼 작업 트리 전체(없으면 마지막 리뷰 지점..HEAD)를 리뷰한다. --base나 --scope를 직접 주면 그 값을 우선한다.
# 리뷰 원문은 stdout과 <저장소 루트>/.claude/review-logs/<시각>-<HEAD 단축 sha>.md에 남는다 (REVIEW_LOG_DIR로 변경 가능).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

MODE=""
if [[ $# -gt 0 && "$1" != -* ]]; then
    MODE="$1"
    shift
fi

HAS_TARGET=0
FULL=0
HAS_FOCUS=0
EXPECT_VALUE=0
ARGS=()
for arg in "$@"; do
    if [[ "${EXPECT_VALUE}" -eq 1 ]]; then
        EXPECT_VALUE=0
    else
        case "${arg}" in
            --full) FULL=1; continue ;;
            --base|--scope) HAS_TARGET=1; EXPECT_VALUE=1 ;;
            --base=*|--scope=*) HAS_TARGET=1 ;;
            --model|-m|--cwd) EXPECT_VALUE=1 ;;
            -*) ;;
            *) HAS_FOCUS=1 ;;
        esac
    fi
    ARGS+=("${arg}")
done
# codex 기본 리뷰(review)는 포커스 텍스트를 받지 않는다
if [[ -z "${MODE}" && "${HAS_FOCUS}" -eq 1 ]]; then
    MODE="adversarial-review"
fi

EXTRA=()
WORKTREE=""
cleanup() {
    if [[ -n "${WORKTREE}" ]]; then
        node "${SCRIPT_DIR}/delta.mjs" cleanup "${WORKTREE}" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

if [[ "${HAS_TARGET}" -eq 0 && "${FULL}" -eq 0 ]]; then
    # 아직 리뷰하지 않은 내용만 담은 임시 worktree를 만든다. 실패하면 --full과 같은 범위로 돌아간다.
    if DELTA="$(node "${SCRIPT_DIR}/delta.mjs" prepare 2>&1)"; then
        while IFS='=' read -r key value; do
            case "${key}" in
                EMPTY) EMPTY="${value}" ;;
                WORKTREE) WORKTREE="${value}" ;;
                BASE) DELTA_BASE="${value}" ;;
                FILES) DELTA_FILES="${value}" ;;
                STAT) DELTA_STAT="${value}" ;;
                MODE) RISK_MODE="${value}" ;;
                RISK) RISK="${value}" ;;
            esac
        done <<< "${DELTA}"
        echo "위험도: ${RISK:-알 수 없음}" >&2
        if [[ "${EMPTY:-0}" == "1" ]]; then
            echo "리뷰할 새 변경이 없습니다. 모든 소스 변경이 이미 리뷰를 통과했거나 공백만 바뀌었습니다. codex를 부르지 않습니다."
            exit 0
        fi
        MODE="${MODE:-${RISK_MODE:-adversarial-review}}"
        echo "리뷰 범위: 아직 리뷰하지 않은 내용만 (${DELTA_STAT:-}). 파일: ${DELTA_FILES//,/, }" >&2
        EXTRA=(--cwd "${WORKTREE}" --base "${DELTA_BASE}")
    else
        echo "리뷰 델타를 만들지 못해 작업 트리 전체를 리뷰합니다: ${DELTA}" >&2
        FULL=1
    fi
fi

if [[ "${HAS_TARGET}" -eq 0 && "${FULL}" -eq 1 ]]; then
    # 작업 트리가 더러우면 작업 트리 전체, 깨끗하면 마지막 리뷰 지점(없으면 첫 커밋)부터 HEAD까지의 커밋
    if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
        EXTRA=(--scope working-tree)
    else
        BASE="$(git rev-parse -q --verify refs/codex-review/last || git rev-list --max-parents=0 HEAD | tail -1)"
        EXTRA=(--base "${BASE}")
    fi
fi
MODE="${MODE:-adversarial-review}"

LOG_DIR="${REVIEW_LOG_DIR:-${REPO_ROOT}/.claude/review-logs}"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD 2>/dev/null || echo initial).md"

if ! git check-ignore -q "${LOG_FILE}" 2>/dev/null; then
    echo "참고: ${LOG_DIR#"${REPO_ROOT}"/}/ 가 .gitignore에 없습니다. 리뷰 로그가 커밋되지 않게 추가를 권장합니다." >&2
fi
echo "모드: ${MODE}. 로그: ${LOG_FILE}" >&2

# pipefail로 companion의 종료 코드를 보존한다.
node "${COMPANION}" "${MODE}" --wait ${EXTRA[@]+"${EXTRA[@]}"} ${ARGS[@]+"${ARGS[@]}"} | tee "${LOG_FILE}"
