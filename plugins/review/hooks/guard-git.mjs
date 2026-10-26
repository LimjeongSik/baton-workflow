#!/usr/bin/env node
// PreToolUse(Bash) 훅: 리뷰를 통과하지 않은 소스 변경이 담기는 git commit / git push를 막는다.
//
// 리뷰 여부는 파일 내용의 blob 해시로 판단한다 (lib/review-state.mjs).
// - commit: 커밋에 담길 수 있는 미커밋 소스 변경(index + 작업 트리)이 전부 리뷰됐는지
// - push:   원격에 없는 커밋들이 바꾼 소스 파일의 HEAD 내용이 전부 리뷰됐는지
// 끄기: REVIEW_GATE=0 (전체), REVIEW_GATE_COMMIT=0 (커밋 먼저 하고 리뷰하는 흐름), REVIEW_GATE_PUSH=0
// codex를 쓸 수 없으면 막지 않고 사용자에게 확인을 받는다.
// 판단할 수 없는 상황(입력 해석 실패, git 실패, 해석할 수 없는 명령 형태)은 통과시키지 않고 막거나 확인을 받는다 (lib/gate-core.mjs).

import { describe, gateDisabled, hasCodexBinary, howToFix, runGitGuard, store } from "../lib/review-state.mjs";

runGitGuard({
    name: "리뷰",
    store,
    gateDisabled,
    onBlocked(call, blocked, what, scope) {
        if (!hasCodexBinary()) {
            return {
                decision: "ask",
                reason: `리뷰를 받지 않은 ${scope}이 있습니다 (${describe(blocked)}). codex CLI를 찾을 수 없어 리뷰할 수 없습니다. 리뷰 없이 ${what}할까요?`,
            };
        }
        return { decision: "deny", reason: `리뷰를 통과하지 않은 ${scope}이 있어 ${what}할 수 없습니다: ${describe(blocked)}. ${howToFix}` };
    },
});
