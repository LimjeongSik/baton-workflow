// 리뷰 상태: "어떤 파일의 어떤 내용이 리뷰를 통과했는가"를 blob 해시로 기록하고 대조한다.
//
// 기록은 <git-dir>/codex-review/reviewed.json에 둔다. 저장소에 커밋되지 않고, worktree마다 따로 관리된다.
// 리뷰 뒤에 파일이 바뀌면 다시 리뷰 대상이 된다. 공백만 바뀐 경우는 이전 통과를 이어받는다.
// 리뷰한 내용은 여러 커밋으로 나눠 담아도 그대로 인정된다.
// 변경 수집·명령 해석·위험도 판정은 gate-core.mjs(정본: 저장소 루트 shared/)에 있다.

import { existsSync } from "node:fs";
import path from "node:path";
import { createStore } from "./gate-core.mjs";

export * from "./gate-core.mjs";

export const REVIEW_REF = "refs/codex-review/last";
export const store = createStore({ dir: "codex-review", file: "reviewed.json", ref: REVIEW_REF });

export const unreviewed = (root, changes) => store.unchecked(root, changes);
export const markReviewed = (root, options) => store.mark(root, options);
export const hasReviewHistory = (root) => store.hasHistory(root);

export function hasCodexBinary() {
    const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    return dirs.some((dir) => existsSync(path.join(dir, "codex")));
}

export function gateDisabled(kind) {
    if (process.env.REVIEW_GATE === "0") return true;
    if (kind === "commit" && process.env.REVIEW_GATE_COMMIT === "0") return true;
    if (kind === "push" && process.env.REVIEW_GATE_PUSH === "0") return true;
    if (kind === "stop" && process.env.REVIEW_GATE_STOP === "0") return true;
    return false;
}

export const howToFix =
    "review:codex 스킬로 리뷰를 받고, 지적을 검증·반영한 뒤 다시 시도하세요. 리뷰는 아직 리뷰하지 않은 내용만 봅니다. " +
    "위험도가 낮은 변경이면 그 스킬의 '자동 생략' 절차로, 리뷰가 필요 없다고 사용자가 동의했다면 '리뷰 생략' 절차로 기록한 뒤 진행하세요.";
