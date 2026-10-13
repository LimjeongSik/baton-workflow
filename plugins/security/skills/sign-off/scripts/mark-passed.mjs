#!/usr/bin/env node
// 지금 시점의 미커밋·미푸시 소스 내용을 "보안 감사 통과"로 기록한다.
// 이 기록이 있어야 guard-git 훅이 커밋·푸시를 허용한다.
//
// 사용법:
//   node mark-passed.mjs                # 감사와 반영을 마친 뒤
//   node mark-passed.mjs --skip "이유"  # 감사가 필요 없는 변경이라고 사용자가 동의했을 때

import { describe, markAudited, repoRoot } from "../../../lib/audit-state.mjs";

const args = process.argv.slice(2);
const index = args.indexOf("--skip");
const reason = index >= 0 ? (args[index + 1] ?? "") : null;
if (reason !== null && reason.trim() === "") {
    console.error('--skip에는 이유가 필요합니다. 예: --skip "포매터 실행 결과만 포함"');
    process.exit(2);
}

const root = repoRoot(process.cwd());
if (!root) {
    console.error("git 저장소가 아닙니다.");
    process.exit(2);
}

const changes = markAudited(root, { reason });
if (changes.length === 0) {
    console.log("기록할 소스 변경이 없습니다.");
} else {
    console.log(`${reason ? "감사 생략으로" : "보안 감사 통과로"} 기록했습니다 (${changes.length}개): ${describe(changes, 20)}`);
}
