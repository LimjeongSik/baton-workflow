#!/usr/bin/env bash
# 목업 HTML을 PNG로 렌더링한다.
#
# 사용법:
#   bash render-mockup.sh <mockup.html> <out.png> [너비=1440] [높이=900]
#
# 전체 페이지를 찍는다 (높이는 첫 화면 기준 뷰포트). 모바일은 390 844를 넘긴다.
# Chrome 계열 브라우저를 먼저 찾고, 없으면 Playwright CLI를 쓴다.
set -euo pipefail

if [[ $# -lt 2 ]]; then
    echo "사용법: bash render-mockup.sh <mockup.html> <out.png> [너비] [높이]" >&2
    exit 2
fi

HTML="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
OUT="$2"
WIDTH="${3:-1440}"
HEIGHT="${4:-900}"
mkdir -p "$(dirname "${OUT}")"
OUT="$(cd "$(dirname "${OUT}")" && pwd)/$(basename "${OUT}")"

if [[ ! -f "${HTML}" ]]; then
    echo "목업 파일이 없습니다: ${HTML}" >&2
    exit 2
fi

# 1) Playwright: 전체 페이지 캡처와 웹폰트 대기가 확실하다.
#    프로젝트에 설치된 버전을 먼저 쓰고, 없으면 최신 버전을 쓴다.
shoot() {
    "$@" screenshot \
        --viewport-size="${WIDTH},${HEIGHT}" \
        --full-page \
        --wait-for-timeout=1200 \
        "file://${HTML}" "${OUT}" >/dev/null 2>&1
}
if command -v npx >/dev/null 2>&1; then
    if shoot npx --no-install playwright || shoot npx -y playwright@latest; then
        echo "${OUT}"
        exit 0
    fi
    # 브라우저 바이너리가 없어서 실패했을 수 있다. 헤드리스 셸만 한 번 받고 다시 시도한다.
    echo "Playwright 브라우저를 내려받습니다 (최초 1회)..." >&2
    if npx -y playwright@latest install chromium-headless-shell >/dev/null 2>&1 && shoot npx -y playwright@latest; then
        echo "${OUT}"
        exit 0
    fi
fi

# 2) Chrome 계열 브라우저: 뷰포트 크기만 찍는다. 긴 페이지는 높이를 크게 넘긴다.
CANDIDATES=(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
    "$(command -v google-chrome 2>/dev/null || true)"
    "$(command -v chromium 2>/dev/null || true)"
    "$(command -v chromium-browser 2>/dev/null || true)"
)
for bin in "${CANDIDATES[@]}"; do
    if [[ -n "${bin}" && -x "${bin}" ]]; then
        "${bin}" --headless=new --disable-gpu --hide-scrollbars \
            --virtual-time-budget=3000 \
            --window-size="${WIDTH},${HEIGHT}" \
            --screenshot="${OUT}" "file://${HTML}" >/dev/null 2>&1
        if [[ -f "${OUT}" ]]; then
            echo "${OUT}"
            exit 0
        fi
    fi
done

echo "렌더링할 브라우저를 찾지 못했습니다. 'npx playwright install chromium' 후 다시 실행하세요." >&2
exit 127
