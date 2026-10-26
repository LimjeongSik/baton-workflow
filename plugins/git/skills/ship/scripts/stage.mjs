#!/usr/bin/env node
// git:ship 파이프라인의 단계 기록: 위험도에 맞는 계획을 세우고, 같은 내용으로 이미 통과한 단계는 다시 돌리지 않게 한다.
//
//   node stage.mjs plan [--json]                         # 위험도, 단계별 계획, 이미 통과한 단계
//   node stage.mjs pass <단계> [--cmd "명령"] [--ms 밀리초]
//   node stage.mjs fail <단계> --reason "원인" [--cmd "명령"] [--ms 밀리초]
//   node stage.mjs log [개수]                            # 최근 실행 기록 (단계, 결과, 시간, 실패 원인)
//
// 단계: checks(lint·타입 검사), tests. 보안 감사·리뷰는 각 플러그인의 통과 기록을 그대로 읽는다.
// 통과는 작업 트리 전체 내용의 지문(tree 해시)에 묶인다. 파일이 하나라도 바뀌면 checks·tests는 다시 돌려야 한다.
// 기록은 <git-dir>/baton/에 둔다 (pipeline.json: 현재 지문의 단계 상태, runs.jsonl: 실행 기록).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { classifyRisk, createStore, git, lines, pendingChanges, repoRoot, unpushedChanges } from "../../../lib/gate-core.mjs";

const STAGES = ["checks", "tests"];
const args = process.argv.slice(2);
const command = args[0];
const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? (args[index + 1] ?? "") : null;
};

const root = repoRoot(process.cwd());
if (!root) {
    console.error("git 저장소가 아닙니다.");
    process.exit(2);
}
const dir = path.resolve(root, git(root, "rev-parse", "--git-path", "baton"));
const stateFile = path.join(dir, "pipeline.json");
const runsFile = path.join(dir, "runs.jsonl");

const loadState = () => {
    try {
        return JSON.parse(readFileSync(stateFile, "utf8"));
    } catch {
        return { fingerprint: null, stages: {} };
    }
};

const gates = {
    audit: createStore({ dir: "security-audit", file: "passed.json" }),
    review: createStore({ dir: "codex-review", file: "reviewed.json" }),
};

function gateStatus(store) {
    const remaining = store.unchecked(root, [...pendingChanges(root), ...unpushedChanges(root)]);
    return remaining.length === 0 ? { status: "passed" } : { status: "pending", files: [...new Set(remaining.map((c) => c.path))] };
}

const PLAN_LABELS = {
    tests: { run: "기존 테스트만 실행", write: "변경 파일 테스트 작성 후 실행" },
    audit: { none: "건너뜀", scan: "시크릿 자동 스캔 → sign-off --auto", full: "security:auditor 감사 → sign-off" },
    review: { none: "건너뜀", skip: "mark-passed --auto로 자동 생략", review: "codex review (델타)", "adversarial-review": "codex adversarial-review (델타)" },
};

if (command === "plan") {
    const risk = classifyRisk(root);
    const state = loadState();
    const fresh = state.fingerprint === risk.tree ? state.stages : {};
    const stages = {
        checks: fresh.checks ?? { status: "todo" },
        tests: fresh.tests ?? { status: "todo" },
        audit: risk.plan.audit === "none" ? { status: "skip" } : gateStatus(gates.audit),
        review: risk.plan.review === "none" ? { status: "skip" } : gateStatus(gates.review),
    };
    const result = { level: risk.level, mode: risk.mode, effective: risk.effective, plan: risk.plan, reasons: risk.reasons, stats: risk.stats, fingerprint: risk.tree, stages };
    if (args.includes("--json")) {
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
    }
    const shown = (stage) => {
        const s = stages[stage];
        if (s.status === "passed") return `통과함${s.cmd ? ` (${s.cmd})` : ""} → 건너뛴다`;
        if (s.status === "failed") return `실패함: ${s.reason} → 이 단계부터 다시`;
        if (s.status === "skip") return "해당 없음";
        if (s.status === "pending") return `필요 (${s.files.slice(0, 5).join(", ")}${s.files.length > 5 ? ` 외 ${s.files.length - 5}개` : ""})`;
        return "아직 안 함";
    };
    console.log(
        [
            `위험도: ${risk.effective}${risk.effective !== risk.level ? ` (판정 ${risk.level}, 모드 ${risk.mode})` : ""} · 소스 ${risk.stats.sourceFiles}개 파일 ${risk.stats.sourceLines}줄`,
            ...risk.reasons.map((reason) => `  - ${reason}`),
            `계획: 테스트=${PLAN_LABELS.tests[risk.plan.tests]} / 보안=${PLAN_LABELS.audit[risk.plan.audit]} / 리뷰=${PLAN_LABELS.review[risk.plan.review]}`,
            `checks: ${shown("checks")}`,
            `tests: ${shown("tests")}`,
            `audit: ${shown("audit")}`,
            `review: ${shown("review")}`,
        ].join("\n"),
    );
} else if (command === "pass" || command === "fail") {
    const stage = args[1];
    if (!STAGES.includes(stage)) {
        console.error(`단계는 ${STAGES.join(", ")} 중 하나입니다. 보안 감사·리뷰는 각 플러그인의 통과 기록을 씁니다.`);
        process.exit(2);
    }
    const reason = option("--reason");
    if (command === "fail" && !reason?.trim()) {
        console.error('fail에는 --reason "원인"이 필요합니다. 다음 실행이 원인부터 볼 수 있게 남긴다.');
        process.exit(2);
    }
    const { tree: fingerprint } = classifyRisk(root);
    const state = loadState();
    if (state.fingerprint !== fingerprint) Object.assign(state, { fingerprint, stages: {} });
    const ms = option("--ms") ? Number(option("--ms")) : undefined;
    const entry = { status: command === "pass" ? "passed" : "failed", at: new Date().toISOString(), cmd: option("--cmd") ?? undefined, ms, reason: reason ?? undefined };
    state.stages[stage] = entry;
    mkdirSync(dir, { recursive: true });
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    appendFileSync(runsFile, `${JSON.stringify({ stage, fingerprint: fingerprint.slice(0, 12), ...entry })}\n`);
    console.log(`${stage}: ${entry.status === "passed" ? "통과" : `실패 (${reason})`}로 기록했습니다.`);
} else if (command === "log") {
    const count = Number(args[1] ?? 20);
    const runs = existsSync(runsFile) ? lines(readFileSync(runsFile, "utf8")).slice(-count) : [];
    if (runs.length === 0) console.log("실행 기록이 없습니다.");
    for (const run of runs.map((line) => JSON.parse(line))) {
        const time = run.ms ? ` ${(run.ms / 1000).toFixed(1)}s` : "";
        console.log(`${run.at} ${run.stage} ${run.status}${time}${run.cmd ? ` · ${run.cmd}` : ""}${run.reason ? ` · ${run.reason}` : ""}`);
    }
} else {
    console.error("사용법: node stage.mjs plan [--json] | pass <단계> | fail <단계> --reason \"원인\" | log [개수]");
    process.exit(2);
}
