#!/usr/bin/env node
// PreToolUse(Bash) 훅: 리뷰를 통과하지 않은 소스 변경이 담기는 git commit / git push를 막는다.
//
// 리뷰 여부는 파일 내용의 blob 해시로 판단한다 (lib/review-state.mjs).
// - commit: 커밋에 담길 수 있는 미커밋 소스 변경(index + 작업 트리)이 전부 리뷰됐는지
// - push:   원격에 없는 커밋들이 바꾼 소스 파일의 HEAD 내용이 전부 리뷰됐는지
// 끄기: REVIEW_GATE=0 (전체), REVIEW_GATE_COMMIT=0 (커밋 먼저 하고 리뷰하는 흐름), REVIEW_GATE_PUSH=0
// codex를 쓸 수 없으면 막지 않고 사용자에게 확인을 받는다. 판단할 수 없는 상황에서는 통과시킨다.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import {
    describe,
    gateDisabled,
    git,
    hasCodexBinary,
    pendingChanges,
    repoRoot,
    unpushedChanges,
    unreviewed,
} from "../lib/review-state.mjs";

const allow = () => process.exit(0);

function decide(decision, reason) {
    process.stdout.write(
        `${JSON.stringify({
            hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason },
        })}\n`,
    );
    process.exit(0);
}

let input;
try {
    input = JSON.parse(readFileSync(0, "utf8"));
} catch {
    allow();
}
const command = String(input?.tool_input?.command ?? "");
if (!/\bgit\b/.test(command) || !/\b(commit|push)\b/.test(command)) allow();

// 셸 명령을 따옴표를 존중해 토큰과 연산자(&&, ||, ;, |, 줄바꿈)로 나눈다.
function lex(cmd) {
    const out = [];
    let cur = "";
    let has = false;
    const push = () => {
        if (has) out.push({ word: cur });
        cur = "";
        has = false;
    };
    for (let i = 0; i < cmd.length; i++) {
        const c = cmd[i];
        if (c === "'") {
            const j = cmd.indexOf("'", i + 1);
            cur += cmd.slice(i + 1, j < 0 ? cmd.length : j);
            has = true;
            i = j < 0 ? cmd.length : j;
        } else if (c === '"') {
            let j = i + 1;
            while (j < cmd.length && cmd[j] !== '"') {
                if (cmd[j] === "\\" && j + 1 < cmd.length) j++;
                cur += cmd[j];
                j++;
            }
            has = true;
            i = j;
        } else if (c === "\\" && i + 1 < cmd.length) {
            cur += cmd[++i];
            has = true;
        } else if (/\s/.test(c) && c !== "\n") {
            push();
        } else if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")") {
            push();
            if ((c === "&" || c === "|") && cmd[i + 1] === c) i++;
            out.push({ op: c });
        } else {
            cur += c;
            has = true;
        }
    }
    push();
    return out;
}

function segments(cmd) {
    const result = [[]];
    for (const token of lex(cmd)) {
        if (token.op) result.push([]);
        else result[result.length - 1].push(token.word);
    }
    return result.filter((words) => words.length > 0);
}

const expandHome = (p) => p.replace(/^~(?=$|\/)/, process.env.HOME ?? "~");

const realpathOr = (p) => {
    try {
        return realpathSync(p);
    } catch {
        return p;
    }
};

// 값을 하나 받는 commit 옵션 (이 값은 경로가 아니다)
const COMMIT_VALUE_OPTIONS = new Set([
    "-m", "--message", "-F", "--file", "-C", "--reuse-message", "-c", "--reedit-message",
    "--author", "--date", "-t", "--template", "--fixup", "--squash", "--cleanup", "--trailer", "-S", "--gpg-sign",
]);

// cd를 따라가며 git 호출을 찾고, 커밋에 담길 경로 단서(git add 인자, commit -a, commit 경로)를 모은다.
function findGitCalls(cmd, startDir) {
    const calls = [];
    const staged = { all: false, trackedOnly: false, paths: [] };
    let dir = startDir;
    for (const words of segments(cmd)) {
        const tokens = [...words];
        while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift(); // VAR=값 접두사
        if (tokens[0] === "cd") {
            if (tokens[1]) dir = path.resolve(dir, expandHome(tokens[1]));
            continue;
        }
        if (tokens[0] !== "git") continue;
        let i = 1;
        let callDir = dir;
        while (i < tokens.length && tokens[i].startsWith("-")) {
            if (tokens[i] === "-C" && tokens[i + 1]) {
                callDir = path.resolve(callDir, expandHome(tokens[i + 1]));
                i += 2;
            } else if (["-c", "--git-dir", "--work-tree", "--namespace"].includes(tokens[i])) {
                i += 2;
            } else {
                i += 1;
            }
        }
        const sub = tokens[i];
        const args = tokens.slice(i + 1);
        if (sub === "add" || sub === "stage") {
            const paths = args.filter((a) => !a.startsWith("-"));
            if (args.some((a) => ["-A", "--all", "-u", "--update"].includes(a)) || paths.some((p) => p === "." || p === ":/")) {
                staged.all = true;
            }
            staged.paths.push(...paths.map((p) => path.relative(callDir, path.resolve(callDir, p))));
        } else if (sub === "commit") {
            const commitPaths = [];
            for (let j = 0; j < args.length; j++) {
                const a = args[j];
                if (a === "--") {
                    commitPaths.push(...args.slice(j + 1));
                    break;
                }
                if (a === "-a" || a === "--all" || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a) && !a.startsWith("--")) {
                    staged.all = true;
                    staged.trackedOnly = true;
                }
                if (COMMIT_VALUE_OPTIONS.has(a) || /^-[a-zA-Z]*[mFCct]$/.test(a)) {
                    j++;
                    continue;
                }
                if (!a.startsWith("-")) commitPaths.push(a);
            }
            calls.push({ sub, args, dir: callDir, staged: { ...staged, paths: [...staged.paths, ...commitPaths.map((p) => path.relative(callDir, path.resolve(callDir, p)))] } });
        } else if (sub === "push") {
            calls.push({ sub, args, dir: callDir });
        }
    }
    return calls;
}

// 이번 커밋에 실제로 담길 수 있는 변경만 고른다: index는 항상, 작업 트리는 add/commit 인자가 가리키는 것만
// root는 git이 돌려준 실제 경로이므로, callDir도 실제 경로로 바꿔야 상대 경로가 맞는다 (/var → /private/var 같은 심볼릭 링크).
function commitCandidates(changes, staged, callDir, root) {
    const prefix = path.relative(root, realpathOr(callDir));
    const targets = staged.paths.map((p) => path.normalize(path.join(prefix, p)));
    const matches = (file) => targets.some((t) => t === "." || file === t || file.startsWith(`${t}/`));
    return changes.filter((change) => {
        if (change.where === "staged") return true;
        if (staged.all) return !(staged.trackedOnly && change.untracked);
        return matches(change.path);
    });
}

function inProgressOperation(root) {
    for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
        if (existsSync(path.resolve(root, git(root, "rev-parse", "--git-path", name)))) return name;
    }
    return null;
}

function isNonContentPush(args) {
    return args.some((arg) => arg === "--delete" || arg === "-d" || arg === "--tags" || /^:/.test(arg));
}

const howToFix =
    "review:codex 스킬로 리뷰를 받고, 지적을 검증·반영한 뒤 다시 시도하세요. " +
    "리뷰가 필요 없는 변경이라고 사용자가 동의했다면 그 스킬의 '리뷰 생략' 절차로 기록한 뒤 진행하세요.";

for (const call of findGitCalls(command, input.cwd ?? process.cwd())) {
    if (gateDisabled(call.sub)) continue;
    const root = repoRoot(call.dir);
    if (!root) continue;

    let blocked;
    try {
        if (call.sub === "commit") {
            const operation = inProgressOperation(root);
            if (operation) continue; // merge·cherry-pick·revert·rebase 중의 커밋은 다른 곳에서 온 내용이다
            blocked = unreviewed(root, commitCandidates(pendingChanges(root), call.staged, call.dir, root));
        } else {
            if (isNonContentPush(call.args)) continue;
            blocked = unreviewed(root, unpushedChanges(root));
        }
    } catch {
        continue;
    }
    if (blocked.length === 0) continue;

    const what = call.sub === "commit" ? "커밋" : "푸시";
    const scope = call.sub === "commit" ? "커밋되지 않은 소스 변경" : "원격에 없는 커밋의 소스 변경";
    if (!hasCodexBinary()) {
        decide(
            "ask",
            `리뷰를 받지 않은 ${scope}이 있습니다 (${describe(blocked)}). codex CLI를 찾을 수 없어 리뷰할 수 없습니다. 리뷰 없이 ${what}할까요?`,
        );
    }
    decide("deny", `리뷰를 통과하지 않은 ${scope}이 있어 ${what}할 수 없습니다: ${describe(blocked)}. ${howToFix}`);
}

allow();
