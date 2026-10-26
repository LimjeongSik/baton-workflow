#!/usr/bin/env node
// 지금 시점의 미커밋·미푸시 소스 내용을 "보안 감사 통과"로 기록한다.
// 이 기록이 있어야 guard-git 훅이 커밋·푸시를 허용한다. 처음 기록할 때 git 훅 백스톱도 설치한다.
//
// 사용법:
//   node mark-passed.mjs                # 감사와 반영을 마친 뒤
//   node mark-passed.mjs --auto         # 위험도가 낮은 변경: 위험도 판정과 시크릿 자동 스캔을 통과할 때만 기록
//   node mark-passed.mjs --skip "이유"  # 감사가 필요 없는 변경이라고 사용자가 동의했을 때
//   node mark-passed.mjs --pending      # 기록하지 않고, 아직 감사를 통과하지 않은 파일만 출력한다

import {
    classifyRisk,
    describe,
    installBackstop,
    markAudited,
    pendingChanges,
    repoRoot,
    scanSecrets,
    unaudited,
    unpushedChanges,
} from "../../../lib/audit-state.mjs";

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

if (args.includes("--pending")) {
    const files = [...new Set(unaudited(root, [...pendingChanges(root), ...unpushedChanges(root)]).map((change) => change.path))];
    console.log(files.length ? files.join("\n") : "감사할 파일이 없습니다. 모든 소스 변경이 감사를 통과했습니다.");
    process.exit(0);
}

let auto = null;
if (args.includes("--auto")) {
    const risk = classifyRisk(root);
    if (risk.plan.audit === "full") {
        console.error(
            `위험도가 ${risk.effective}(모드 ${risk.mode})라서 감사를 자동으로 기록할 수 없습니다. security:auditor로 감사하세요.\n근거: ${risk.reasons.join(" / ") || "strict 모드"}`,
        );
        process.exit(3);
    }
    const secrets = scanSecrets(root, { tree: risk.tree, base: risk.base });
    if (secrets.length > 0) {
        console.error(`시크릿 자동 스캔에 걸려 자동으로 기록할 수 없습니다. 파일을 열어 확인하고 security:audit로 감사하세요.\n${secrets.join("\n")}`);
        process.exit(3);
    }
    auto = `risk:${risk.effective} + 시크릿 스캔 통과`;
}

let changes;
try {
    changes = markAudited(root, { reason, auto });
} catch (error) {
    console.error(error.message);
    process.exit(2);
}
const label = reason ? "감사 생략으로" : auto ? `자동 기록으로(${auto})` : "보안 감사 통과로";
if (changes.length === 0) {
    console.log("기록할 소스 변경이 없습니다.");
} else {
    console.log(`${label} 기록했습니다 (${changes.length}개): ${describe(changes, 20)}`);
}
const backstop = installBackstop(root);
if (backstop) console.log(backstop);
