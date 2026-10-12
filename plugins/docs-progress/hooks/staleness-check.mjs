#!/usr/bin/env node
// SessionStart 훅: 진행 문서의 "최종 갱신" 날짜 이후 쌓인 커밋을 세어, 갱신이 필요하면 컨텍스트로 알린다.
//
// 진행 문서가 없는 저장소에서는 아무것도 하지 않는다 (opt-in).
// 경로는 DOCS_PROGRESS_PATH(저장소 루트 기준, 기본 docs/PROGRESS.md)로 바꿀 수 있다.
// 차단하지 않는다. 판단할 수 없으면 조용히 통과한다.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const DOC = process.env.DOCS_PROGRESS_PATH ?? "docs/PROGRESS.md";
const STALE_DAYS = 7;

const done = () => process.exit(0);

function git(cwd, ...args) {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

let input = {};
try {
    input = JSON.parse(readFileSync(0, "utf8"));
} catch {}

let root;
try {
    root = git(input.cwd ?? process.cwd(), "rev-parse", "--show-toplevel");
} catch {
    done();
}

const docPath = path.join(root, DOC);
if (!existsSync(docPath)) done();

const updated = readFileSync(docPath, "utf8").match(/최종 갱신:\s*(\d{4}-\d{2}-\d{2})/)?.[1];

let commits = [];
try {
    // 갱신일 당일 커밋은 이미 반영됐을 수 있으므로 다음 날부터 센다. 진행 문서만 바꾼 커밋은 제외한다.
    const since = updated ? ["--since", `${updated} 23:59:59`] : [];
    commits = git(root, "log", "--format=%h %ad %s", "--date=short", ...since, "--", ".", `:(exclude)${DOC}`)
        .split("\n")
        .filter(Boolean);
} catch {
    done();
}

const ageDays = updated ? Math.floor((Date.now() - Date.parse(`${updated}T00:00:00`)) / 86_400_000) : null;
if (updated && commits.length === 0) done();
if (updated && commits.length < 3 && ageDays < STALE_DAYS) done();

const head = commits.slice(0, 10).join("\n");
const more = commits.length > 10 ? `\n... 외 ${commits.length - 10}개` : "";
const context = updated
    ? `진행 문서 ${DOC}의 최종 갱신은 ${updated}(${ageDays}일 전)이고, 그 뒤 반영되지 않은 커밋이 ${commits.length}개 있다:\n${head}${more}\n작업을 시작하기 전에 ${DOC}를 읽되, 위 커밋 내용은 문서에 아직 없다는 점을 감안한다. 이번 세션의 작업을 마칠 때 docs-progress:update 스킬로 문서를 갱신한다.`
    : `진행 문서 ${DOC}에 "최종 갱신: YYYY-MM-DD" 줄이 없어 갱신 시점을 알 수 없다. 작업을 마칠 때 docs-progress:update 스킬로 문서를 갱신해 형식을 맞춘다.`;

process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } })}\n`,
);
