#!/usr/bin/env node
// 리뷰 델타: 아직 리뷰하지 않은 내용만 codex에게 보이도록 임시 worktree를 만든다 (run-codex.sh가 부른다).
//
//   node delta.mjs prepare        # KEY=값 줄로 출력: EMPTY, WORKTREE, BASE, FILES, STAT, MODE, RISK
//   node delta.mjs cleanup <경로> # 임시 worktree 제거
//
// 임시 worktree는 지금 작업 트리 내용(C)을 체크아웃하고, 부모 커밋(R)은 통과하지 않은 파일만 마지막 통과 내용으로 되돌린 상태다.
// 그래서 `--base R`로 리뷰하면 이미 리뷰한 파일과 이미 리뷰한 줄은 diff에 나오지 않는다. 두 커밋은 어떤 ref에도 걸리지 않아 gc된다.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildDelta, classifyRisk, git, repoRoot, store, tryGit } from "../../../lib/review-state.mjs";

const [command, target] = process.argv.slice(2);
const root = repoRoot(process.cwd());
if (!root) {
    console.error("git 저장소가 아닙니다.");
    process.exit(2);
}

const emit = (key, value) => console.log(`${key}=${String(value).replace(/\n/g, " ")}`);

if (command === "prepare") {
    const risk = classifyRisk(root);
    const delta = buildDelta(root, store, { tree: risk.tree, base: risk.base });
    emit("RISK", `${risk.effective}${risk.reasons.length ? ` (${risk.reasons.join(" / ")})` : ""}`);
    emit("MODE", risk.plan.review === "adversarial-review" ? "adversarial-review" : "review");
    if (delta.empty) {
        emit("EMPTY", 1);
        process.exit(0);
    }
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "baton-review-")));
    rmSync(dir, { recursive: true, force: true });
    git(root, "worktree", "add", "--detach", "-q", dir, delta.current);
    emit("EMPTY", 0);
    emit("WORKTREE", dir);
    emit("BASE", delta.reviewed);
    emit("FILES", delta.files.join(","));
    emit("STAT", delta.stat);
} else if (command === "cleanup" && target) {
    tryGit(root, "worktree", "remove", "--force", target);
    rmSync(target, { recursive: true, force: true });
    tryGit(root, "worktree", "prune");
} else {
    console.error("사용법: node delta.mjs prepare | cleanup <경로>");
    process.exit(2);
}
