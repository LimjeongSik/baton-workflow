#!/usr/bin/env bash
# 목업 HTML(또는 레퍼런스 웹페이지 URL)을 PNG로 렌더링한다.
#
# 사용법:
#   bash render-mockup.sh <mockup.html | https://...> <out.png> [너비=1440] [높이=900]
#
# stdout 첫 줄: 저장한 PNG 경로. 둘째 줄: 캡처 범위("전체 페이지" 또는 "뷰포트 WxH만").
# 셋째 줄부터: "경고: ..." (제한 시간 안에 끝나지 않은 웹폰트·이미지, 로딩에 실패한 이미지)
# Playwright가 있으면 웹폰트·이미지 로딩을 최대 8초 기다려 전체 페이지를 찍는다.
# 없으면 Chrome 계열 브라우저로 뷰포트 크기만 찍는다. 이때는 아래가 잘렸는지 PNG에서 직접 확인한다.
# Chrome은 500px보다 좁은 폭을 바르게 그리지 못해서, 모바일 폭은 Playwright가 없으면 실패한다.
# 새로 찍는 데 성공했을 때만 <out.png>를 교체한다. 실패하면 예전 파일을 그대로 두고 종료 코드 127을 낸다.
set -euo pipefail

if [[ $# -lt 2 ]]; then
    echo "사용법: bash render-mockup.sh <mockup.html | https://...> <out.png> [너비] [높이]" >&2
    exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$2"
WIDTH="${3:-1440}"
HEIGHT="${4:-900}"
mkdir -p "$(dirname "${OUT}")"
OUT="$(cd "$(dirname "${OUT}")" && pwd)/$(basename "${OUT}")"

if [[ "$1" =~ ^https?:// ]]; then
    TARGET="$1"
else
    HTML="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
    if [[ ! -f "${HTML}" ]]; then
        echo "목업 파일이 없습니다: ${HTML}" >&2
        exit 2
    fi
    TARGET="file://${HTML}"
fi

TMP="${OUT%.png}.rendering-$$.png"
LOG="$(mktemp "${TMPDIR:-/tmp}/render-mockup.XXXXXX")"
LAST="$(mktemp "${TMPDIR:-/tmp}/render-mockup.XXXXXX")"
trap 'rm -f "${TMP}" "${LOG}" "${LAST}"' EXIT

# 임시 파일에 새로 찍혔는지로 성공을 판단한다. 예전 <out.png>가 남아 있어도 성공으로 보지 않는다.
done_with() {
    if [[ -s "${TMP}" ]]; then
        mv -f "${TMP}" "${OUT}"
        echo "${OUT}"
        echo "$1"
        sed -n 's/^WARN: /경고: /p' "${LAST}"
        exit 0
    fi
}

attempt() {
    local label="$1"
    shift
    echo "== ${label}" >>"${LOG}"
    rm -f "${TMP}"
    "$@" >"${LAST}" 2>&1 || true
    cat "${LAST}" >>"${LOG}"
}

# 1) Playwright: 프로젝트에 설치된 버전을 먼저 쓰고, 없으면 최신 버전을 받아 쓴다.
if command -v node >/dev/null 2>&1; then
    LOCAL_PW="$(node -e 'try{console.log(require.resolve("playwright"))}catch{}' 2>/dev/null || true)"
    if [[ -n "${LOCAL_PW}" ]]; then
        attempt "프로젝트 Playwright" node "${SCRIPT_DIR}/shoot.cjs" "${LOCAL_PW}" "${TARGET}" "${TMP}" "${WIDTH}" "${HEIGHT}"
        done_with "전체 페이지"
    fi
fi
if command -v npx >/dev/null 2>&1; then
    # npx 캐시에 받은 playwright 패키지 경로를 찾아 shoot.cjs에 넘긴다.
    export SHOOT_JS="${SCRIPT_DIR}/shoot.cjs" SHOOT_TARGET="${TARGET}" SHOOT_OUT="${TMP}" SHOOT_W="${WIDTH}" SHOOT_H="${HEIGHT}"
    PW_SHOOT='node "$SHOOT_JS" "$(dirname "$(command -v playwright)")/../playwright" "$SHOOT_TARGET" "$SHOOT_OUT" "$SHOOT_W" "$SHOOT_H"'
    attempt "playwright@latest" npx -y -p playwright@latest -c "${PW_SHOOT}"
    done_with "전체 페이지"
    # 브라우저 바이너리가 없어서 실패했으면 헤드리스 셸만 한 번 받고 다시 시도한다.
    if grep -q "Executable doesn't exist\|playwright install" "${LOG}"; then
        echo "Playwright 브라우저를 내려받습니다 (최초 1회)..." >&2
        attempt "브라우저 설치" npx -y playwright@latest install chromium-headless-shell
        attempt "playwright@latest (설치 후)" npx -y -p playwright@latest -c "${PW_SHOOT}"
        done_with "전체 페이지"
    fi
fi

# 2) Chrome 계열 브라우저: 뷰포트 크기만 찍는다.
#    헤드리스 Chrome은 창 폭이 500px보다 좁아도 500px로 배치하고 이미지만 잘라 내서,
#    모바일 폭에서는 오른쪽이 잘린 틀린 그림이 나온다. 그 폭에서는 쓰지 않고 실패로 끝낸다.
if (( WIDTH < 500 )); then
    echo "== Chrome 대체 경로 건너뜀: 헤드리스 Chrome은 ${WIDTH}px 폭을 500px로 배치해서 모바일 렌더링이 틀린다. Playwright가 필요하다" >>"${LOG}"
    CANDIDATES=()
else
CANDIDATES=(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
    "$(command -v google-chrome 2>/dev/null || true)"
    "$(command -v chromium 2>/dev/null || true)"
    "$(command -v chromium-browser 2>/dev/null || true)"
)
fi
for bin in "${CANDIDATES[@]+"${CANDIDATES[@]}"}"; do
    if [[ -n "${bin}" && -x "${bin}" ]]; then
        attempt "${bin}" "${bin}" --headless=new --disable-gpu --hide-scrollbars \
            --virtual-time-budget=5000 \
            --window-size="${WIDTH},${HEIGHT}" \
            --screenshot="${TMP}" "${TARGET}"
        done_with "뷰포트 ${WIDTH}x${HEIGHT}만 (아래로 넘친 내용은 찍히지 않음. 잘렸는지 PNG에서 확인)"
    fi
done

echo "렌더링에 실패했습니다. 브라우저가 없으면 'npx playwright install chromium' 후 다시 실행하세요. 시도한 순서와 오류:" >&2
grep -E "^== |Error|ERR_|Executable|not found|No such|Timeout" "${LOG}" \
    | grep -v "cv_display_link\|task_policy_set" | tail -n 20 >&2
exit 127
