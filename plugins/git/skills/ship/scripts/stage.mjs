#!/usr/bin/env node
// git:ship 파이프라인의 단계 기록: 위험도에 맞는 계획을 세우고, 같은 내용으로 이미 통과한 단계는 다시 돌리지 않게 한다.
//
//   node stage.mjs plan [--json]                                  # 위험도, 단계별 계획, 이미 통과한 단계
//   node stage.mjs run <단계> [--partial] [--env 이름,이름] -- <명령>  # 명령을 실행하고 결과를 그 실행 환경과 함께 기록
//   node stage.mjs pass <단계> --cmd "명령" [--ms 밀리초] [--partial] [--env 이름,이름]   # 이미 돌린 결과를 기록 (재사용)
//   node stage.mjs fail <단계> --reason "원인" [--cmd "명령"] [--ms 밀리초]
//   node stage.mjs log [개수]                                     # 최근 실행 기록 (단계, 결과, 시간, 실패 원인)
//
// 단계: checks(lint·타입 검사), tests. 보안 감사·리뷰는 각 플러그인의 통과 기록을 그대로 읽는다.
// 통과는 작업 트리 전체 내용의 지문(tree 해시)과 실행 환경에 묶인다. 재사용 판단은 gate-core의 stageReuse가 하고,
// progress 플러그인의 facts.mjs도 같은 함수를 쓴다.
// run은 검사를 이 프로세스의 자식으로 돌리므로, 기록된 환경이 곧 검사가 실행된 환경이다. pass는 기록 시점의 환경을
// 남기므로 검사와 같은 셸에서, 명령 앞의 인라인 환경 변수까지 --cmd에 그대로 넣어 기록해야 한다.
// 기록은 <git-dir>/baton/에 둔다 (pipeline.json: 현재 지문의 단계 상태, runs.jsonl: 실행 기록).

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
    classifyRisk,
    createStore,
    git,
    lines,
    maskCommand,
    pendingChanges,
    repoRoot,
    snapshotTree,
    stageEnvironment,
    stageEnvironmentDiff,
    stageReuse,
    unpushedChanges,
} from "../../../lib/gate-core.mjs";

const STAGES = ["checks", "tests"];
const separator = process.argv.indexOf("--");
const args = process.argv.slice(2, separator >= 0 ? separator : undefined);
const trailing = separator >= 0 ? process.argv.slice(separator + 1) : [];
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

function checkStage(stage) {
    if (!STAGES.includes(stage)) {
        console.error(`단계는 ${STAGES.join(", ")} 중 하나입니다. 보안 감사·리뷰는 각 플러그인의 통과 기록을 씁니다.`);
        process.exit(2);
    }
}

// fingerprint·env를 넘기면(run) 검사 직전에 잡은 값을 쓴다. 검사가 실제로 본 내용이 그것이기 때문이다.
function record(stage, { passed, cmd, ms, reason, scope, envNames, fingerprint = snapshotTree(root), env = stageEnvironment(root, { cmd, names: envNames }), unstable }) {
    const state = loadState();
    if (state.fingerprint !== fingerprint) Object.assign(state, { fingerprint, stages: {} });
    const entry = {
        status: passed ? "passed" : "failed",
        at: new Date().toISOString(),
        cmd: maskCommand(cmd) ?? undefined,
        ms,
        reason: reason ?? undefined,
        scope,
        env,
        unstable,
    };
    state.stages[stage] = entry;
    mkdirSync(dir, { recursive: true });
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    appendFileSync(runsFile, `${JSON.stringify({ stage, fingerprint: fingerprint.slice(0, 12), ...entry })}\n`);
    const scopeNote = unstable ? ` (${unstable} → 재사용하지 않음)` : scope === "partial" ? " (일부 범위라 재사용하지 않음)" : "";
    console.log(`${stage}: ${passed ? "통과" : `실패 (${reason})`}로 기록했습니다.${scopeNote}`);
}

const envNamesOption = () => (option("--env") ?? "").split(",").map((name) => name.trim()).filter(Boolean);
const scopeOption = () => (args.includes("--partial") ? "partial" : "full");

if (command === "plan") {
    const risk = classifyRisk(root);
    const state = loadState();
    const reuse = (stage) => {
        const result = stageReuse(root, state.stages?.[stage], { fingerprint: state.fingerprint, tree: risk.tree });
        return result.status === "changed" ? { status: "todo" } : result;
    };
    const stages = {
        checks: reuse("checks"),
        tests: reuse("tests"),
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
        const cmd = s.cmd ? ` (${s.cmd})` : "";
        if (s.status === "passed") return `통과함${cmd} → 건너뛴다`;
        if (s.status === "failed") return `실패함: ${s.reason} → 이 단계부터 다시`;
        if (s.status === "stale") return `통과했지만 환경이 다름: ${s.reason} → 다시 실행${cmd}`;
        if (s.status === "partial") return `일부 범위만 통과함${cmd} → 전체 범위로 다시 실행`;
        if (s.status === "unstable") return `통과했지만 재사용할 수 없음: ${s.reason} → 다시 실행`;
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
} else if (command === "run") {
    const stage = args[1];
    checkStage(stage);
    const cmd = trailing.join(" ").trim();
    if (!cmd) {
        console.error("run에는 실행할 명령이 필요합니다: node stage.mjs run tests -- npm test");
        process.exit(2);
    }
    // 검사 직전의 작업 트리·환경을 잡아 두고, 끝난 뒤 다시 비교한다. 도중에 바뀌었으면 검사가 어느 내용을 봤는지
    // 특정할 수 없으므로, 결과는 남기되 재사용할 수 있는 통과로 기록하지 않는다.
    const envNames = envNamesOption();
    const before = { tree: snapshotTree(root), env: stageEnvironment(root, { cmd, names: envNames }) };
    const started = Date.now();
    const child = spawnSync(cmd, { cwd: process.cwd(), shell: true, stdio: "inherit" });
    const ms = Date.now() - started;
    const code = child.status ?? 1;
    const reason = code === 0 ? null : child.signal ? `시그널 ${child.signal}로 종료` : `종료 코드 ${code}`;
    const changes = [];
    if (snapshotTree(root) !== before.tree) changes.push("검사 도중 작업 트리가 바뀜");
    const envDiff = stageEnvironmentDiff(root, before.env, { cmd });
    if (envDiff.length) changes.push(`검사 도중 환경이 바뀜: ${envDiff.join(", ")}`);
    record(stage, { passed: code === 0, cmd, ms, reason, scope: scopeOption(), envNames, fingerprint: before.tree, env: before.env, unstable: changes.join("; ") || undefined });
    process.exit(code);
} else if (command === "pass" || command === "fail") {
    const stage = args[1];
    checkStage(stage);
    const reason = option("--reason");
    if (command === "fail" && !reason?.trim()) {
        console.error('fail에는 --reason "원인"이 필요합니다. 다음 실행이 원인부터 볼 수 있게 남긴다.');
        process.exit(2);
    }
    const ms = option("--ms") ? Number(option("--ms")) : undefined;
    record(stage, { passed: command === "pass", cmd: option("--cmd"), ms, reason, scope: scopeOption(), envNames: envNamesOption() });
} else if (command === "log") {
    const count = Number(args[1] ?? 20);
    const runs = existsSync(runsFile) ? lines(readFileSync(runsFile, "utf8")).slice(-count) : [];
    if (runs.length === 0) console.log("실행 기록이 없습니다.");
    for (const run of runs.map((line) => JSON.parse(line))) {
        const time = run.ms ? ` ${(run.ms / 1000).toFixed(1)}s` : "";
        const partial = run.scope === "partial" ? " (일부)" : "";
        console.log(`${run.at} ${run.stage} ${run.status}${partial}${time}${run.cmd ? ` · ${run.cmd}` : ""}${run.reason ? ` · ${run.reason}` : ""}${run.env ? ` · ${run.env.runtime}` : ""}`);
    }
} else {
    console.error('사용법: node stage.mjs plan [--json] | run <단계> [--partial] -- <명령> | pass <단계> --cmd "명령" [--partial] [--env 이름,이름] | fail <단계> --reason "원인" | log [개수]');
    process.exit(2);
}
