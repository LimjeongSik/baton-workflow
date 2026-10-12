#!/usr/bin/env node
// 지금 시점의 미커밋·미푸시 소스 내용을 "리뷰 통과"로 기록하고 refs/codex-review/last를 HEAD로 옮긴다.
// 이 기록이 있어야 git-gate 훅이 커밋·푸시를 허용한다.
//
// 사용법:
//   node mark-reviewed.mjs                    # 리뷰와 반영을 마친 뒤
//   node mark-reviewed.mjs --log <리뷰 로그>  # 리뷰 로그 경로를 함께 남길 때
//   node mark-reviewed.mjs --skip "이유"      # 리뷰가 필요 없는 변경이라고 사용자가 동의했을 때

import { describe, markReviewed, repoRoot } from "../../../lib/review-state.mjs";

const args = process.argv.slice(2);
const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? (args[index + 1] ?? "") : null;
};

const reason = option("--skip");
if (reason !== null && reason.trim() === "") {
    console.error('--skip에는 이유가 필요합니다. 예: --skip "README 오타 수정만 포함"');
    process.exit(2);
}

const root = repoRoot(process.cwd());
if (!root) {
    console.error("git 저장소가 아닙니다.");
    process.exit(2);
}

const changes = markReviewed(root, { reason, logFile: option("--log") });
if (changes.length === 0) {
    console.log("기록할 소스 변경이 없습니다. 기준점만 HEAD로 옮겼습니다.");
} else {
    console.log(`${reason ? "리뷰 생략으로" : "리뷰 통과로"} 기록했습니다 (${changes.length}개): ${describe(changes, 20)}`);
}
