#!/usr/bin/env node
// SessionStart 훅: 선호 문서를 읽어 그 내용을 컨텍스트로 넣는다. 매 세션 첫 작업부터 사용자 방식대로 진행하게 하기 위해서다.
//
// 선호 문서가 없는 저장소에서는 아무것도 하지 않는다 (opt-in).
// 경로는 DOCS_PREFERENCES_PATH(저장소 루트 기준, 기본 docs/PREFERENCES.md)로 바꿀 수 있다.
// 차단하지 않는다. 판단할 수 없으면 조용히 통과한다.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const DOC = process.env.DOCS_PREFERENCES_PATH ?? "docs/PREFERENCES.md";
const MAX_CHARS = 8000;

const done = () => process.exit(0);

let input = {};
try {
    input = JSON.parse(readFileSync(0, "utf8"));
} catch {}

const cwd = input.cwd ?? process.cwd();
let root = cwd;
try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {}

const docPath = path.join(root, DOC);
if (!existsSync(docPath)) done();

let body;
try {
    body = readFileSync(docPath, "utf8").trim();
} catch {
    done();
}
if (!body) done();

const truncated = body.length > MAX_CHARS;
const shown = truncated ? body.slice(0, MAX_CHARS) : body;
const tail = truncated ? `\n\n(문서가 길어 ${MAX_CHARS}자에서 잘랐다. 나머지는 ${DOC}를 직접 읽고, 작업을 마칠 때 prefs:learn 스킬로 문서를 줄인다.)` : "";
const context = `이 프로젝트의 사용자 선호 문서(${DOC})다. 사용자가 이전 작업에서 고르거나 고쳐 준 방식이다. [확정] 항목은 묻지 않고 기본값으로 따르고, [관찰] 항목은 선택지를 고를 때 먼저 고려하고, [추정] 항목은 다른 근거가 없을 때만 따르고 따랐으면 보고에 밝힌다. 이번 요청이 이 문서와 다르면 요청을 따른다. 작업 중 사용자가 고르거나 고친 것, 또는 사용자의 행동에서 새로 드러난 방식이 있으면 작업을 마칠 때 prefs:learn 스킬로 기록한다.\n\n${shown}${tail}`;

process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } })}\n`,
);
