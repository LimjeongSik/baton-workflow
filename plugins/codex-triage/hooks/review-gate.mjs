#!/usr/bin/env node
// Stop 훅: 마지막 리뷰 지점(refs/codex-review/last) 이후 리뷰되지 않은 커밋이 있으면 review-apply 스킬 실행을 요구한다.
//
// 판단 근거는 transcript가 아니라 git ref다.
// ref가 없는 저장소에서는 동작하지 않는다 — 첫 리뷰를 마쳐 ref가 생긴 저장소에서만 게이트가 켜진다(opt-in).
// CODEX_TRIAGE_GATE=0 이면 끈다.
// 판단이 불가능한 상황(파싱 실패, codex 미설치, git 실패 등)에서는 항상 통과시킨다 — 훅이 작업을 막아서는 안 된다.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const REVIEW_REF = "refs/codex-review/last";

const allow = () => process.exit(0);

function readStdin() {
    try {
        return JSON.parse(readFileSync(0, "utf8"));
    } catch {
        return null;
    }
}

function hasCodexBinary() {
    const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    return dirs.some((dir) => existsSync(path.join(dir, "codex")));
}

function git(cwd, ...args) {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

if (process.env.CODEX_TRIAGE_GATE === "0") allow();

const input = readStdin();
if (!input || input.stop_hook_active) allow();
if (!hasCodexBinary()) allow();

const cwd = input.cwd ?? process.cwd();

let head;
let last;
let count;
try {
    head = git(cwd, "rev-parse", "HEAD");
    try {
        last = git(cwd, "rev-parse", "-q", "--verify", REVIEW_REF);
    } catch {
        // ref가 없으면 이 저장소는 게이트를 쓰지 않는 것 — 통과
        last = null;
    }
    if (!last || last === head) allow();
    count = git(cwd, "rev-list", "--count", `${last}..${head}`);
} catch {
    allow();
}

process.stdout.write(
    `${JSON.stringify({
        decision: "block",
        reason: `리뷰되지 않은 커밋이 있습니다 (${last.slice(0, 7)}..${head.slice(0, 7)}, ${count}개). codex-triage:review-apply 스킬을 실행하세요. 리뷰가 필요 없는 변경(문서만 등)이면 이유를 한 줄로 밝히고 git update-ref ${REVIEW_REF} HEAD 후 종료하세요.`,
    })}\n`,
);
process.exit(0);
