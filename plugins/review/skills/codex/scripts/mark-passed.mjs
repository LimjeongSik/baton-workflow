#!/usr/bin/env node
// 지금 시점의 미커밋·미푸시 소스 내용을 "리뷰 통과"로 기록하고 refs/codex-review/last를 HEAD로 옮긴다.
// 이 기록이 있어야 guard-git 훅이 커밋·푸시를 허용한다. 처음 기록할 때 git 훅 백스톱도 설치한다.
//
// 사용법:
//   node mark-passed.mjs                    # 리뷰와 반영을 마친 뒤
//   node mark-passed.mjs --log <리뷰 로그>  # 리뷰 로그 경로를 함께 남길 때
//   node mark-passed.mjs --auto             # 위험도가 낮아 리뷰를 건너뛰는 변경 (위험도를 다시 판정해 맞을 때만 기록)
//   node mark-passed.mjs --skip "이유"      # 리뷰가 필요 없는 변경이라고 사용자가 동의했을 때

import { classifyRisk, describe, installBackstop, markReviewed, repoRoot } from "../../../lib/review-state.mjs";

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

let auto = null;
if (args.includes("--auto")) {
    const risk = classifyRisk(root);
    if (risk.plan.review !== "skip" && risk.plan.review !== "none") {
        console.error(
            `위험도가 ${risk.effective}(모드 ${risk.mode})라서 리뷰를 자동으로 건너뛸 수 없습니다. review:codex로 리뷰하세요.` +
                (risk.reasons.length ? `\n근거: ${risk.reasons.join(" / ")}` : `\n규모: 소스 ${risk.stats.sourceFiles}개 파일, ${risk.stats.sourceLines}줄`),
        );
        process.exit(3);
    }
    auto = `risk:${risk.effective} (소스 ${risk.stats.sourceFiles}개 파일, ${risk.stats.sourceLines}줄)`;
}

let changes;
try {
    changes = markReviewed(root, { reason, auto, logFile: option("--log") });
} catch (error) {
    console.error(error.message);
    process.exit(2);
}
const label = reason ? "리뷰 생략으로" : auto ? `위험도가 낮아 자동 생략으로(${auto})` : "리뷰 통과로";
if (changes.length === 0) {
    console.log("기록할 소스 변경이 없습니다. 기준점만 HEAD로 옮겼습니다.");
} else {
    console.log(`${label} 기록했습니다 (${changes.length}개): ${describe(changes, 20)}`);
}
const backstop = installBackstop(root);
if (backstop) console.log(backstop);
