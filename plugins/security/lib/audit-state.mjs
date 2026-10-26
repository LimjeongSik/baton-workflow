// 보안 감사 상태: "어떤 파일의 어떤 내용이 보안 감사를 통과했는가"를 blob 해시로 기록하고 대조한다.
//
// 기록은 <git-dir>/security-audit/passed.json에 둔다. 저장소에 커밋되지 않고, worktree마다 따로 관리된다.
// 감사 뒤에 파일이 바뀌면 다시 감사 대상이 된다 (리뷰 반영으로 바뀐 파일 포함). 공백만 바뀐 경우는 이전 통과를 이어받는다.
// 감사한 내용은 여러 커밋으로 나눠 담아도 그대로 인정된다.
// 변경 수집·명령 해석·위험도 판정은 gate-core.mjs(정본: 저장소 루트 shared/)에 있다.

import { createStore } from "./gate-core.mjs";

export * from "./gate-core.mjs";

export const store = createStore({ dir: "security-audit", file: "passed.json" });

export const unaudited = (root, changes) => store.unchecked(root, changes);
export const markAudited = (root, options) => store.mark(root, options);

export function gateDisabled(kind) {
    if (process.env.SECURITY_GATE === "0") return true;
    if (kind === "commit" && process.env.SECURITY_GATE_COMMIT === "0") return true;
    if (kind === "push" && process.env.SECURITY_GATE_PUSH === "0") return true;
    return false;
}

export const howToFix =
    "security:audit 스킬(또는 security:auditor 에이전트)로 감사하고, 지적을 검증·반영한 뒤 " +
    "security:sign-off 스킬로 통과를 기록하고 다시 시도하세요. 위험도가 낮은 변경이면 sign-off의 '자동 기록'을 먼저 시도하세요. " +
    "감사 뒤에 리뷰 반영 등으로 파일이 바뀌었다면 바뀐 파일만 다시 감사하면 됩니다.";
