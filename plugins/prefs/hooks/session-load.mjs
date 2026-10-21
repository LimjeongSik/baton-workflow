#!/usr/bin/env node
// SessionStart 훅: Claude가 사용자의 작업 방식을 스스로 학습하도록 안내를 넣는다.
//
// 학습 결과(프로필)는 <설정 폴더>/prefs/profile.md에 있고 <설정 폴더>/CLAUDE.md가 불러온다.
// CLAUDE.md가 아직 불러오지 않으면 프로필 내용을 직접 넣는다.
// 프로젝트에 옛 선호 문서(DOCS_PREFERENCES_PATH, 기본 docs/PREFERENCES.md)가 있으면 그 내용도 넣고 프로필로 옮기라고 알린다.
// 설정 폴더는 CLAUDE_CONFIG_DIR, 없으면 ~/.claude다.
// 차단하지 않는다. 판단할 수 없으면 조용히 통과한다.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
const PROFILE = path.join(CONFIG_DIR, "prefs", "profile.md");
const IMPORT_MARK = "<!-- prefs:start -->";
const LEGACY_DOC = process.env.DOCS_PREFERENCES_PATH ?? "docs/PREFERENCES.md";
const MAX_CHARS = 8000;

const read = (file) => {
    try {
        return readFileSync(file, "utf8").trim();
    } catch {
        return "";
    }
};

const clip = (body, name) =>
    body.length > MAX_CHARS
        ? `${body.slice(0, MAX_CHARS)}\n\n(${name}가 길어 ${MAX_CHARS}자에서 잘랐다. prefs:learn 스킬로 recorder에게 tidy를 넘겨 줄인다.)`
        : body;

let input = {};
try {
    input = JSON.parse(readFileSync(0, "utf8"));
} catch {}

const cwd = input.cwd ?? process.cwd();
let root = cwd;
try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {}

const FOLLOW = "[확정]은 묻지 않고 따르고, [추정]은 다른 근거가 없을 때만 따르고 따랐으면 보고에 밝힌다. 이번 요청이나 프로젝트 CLAUDE.md와 다르면 그쪽을 따른다.";
const parts = [
    "Claude는 사용자의 작업 방식을 스스로 학습한다. 사용자가 시키기를 기다리지 않고, \"기억해 둘까요?\", \"메모해 둘까요?\", \"선호로 기록할까요?\"처럼 묻지도 않는다. 기록할지는 Claude가 판단 근거로 정한다. 작업 중 사용자가 고르거나 고친 것, 거절한 것, 일반 지시, 사용자의 행동에서 드러난 방식, 프로필대로 한 결과를 사용자가 받아들였는지 고쳤는지를 지켜보고, 작업을 마칠 때 신호가 있었다고 판단하면 prefs:learn 스킬로 넘긴다. 신호는 근거일 뿐이고, 여러 작업에서 같은 방향이 확인된 것만 프로필 지시문이 된다.",
];

const profile = read(PROFILE);
const claudeMd = read(path.join(CONFIG_DIR, "CLAUDE.md"));
if (!profile) {
    parts.push("아직 학습된 프로필이 없다. 신호가 쌓이면 recorder가 프로필을 만들고 CLAUDE.md에서 불러오게 한다.");
} else if (claudeMd.includes(IMPORT_MARK) || claudeMd.includes(PROFILE)) {
    parts.push(`학습된 프로필(${PROFILE})은 CLAUDE.md로 이미 불러왔다. ${FOLLOW}`);
} else {
    parts.push(
        `학습된 프로필(${PROFILE})을 CLAUDE.md가 아직 불러오지 않아 여기 넣는다. 다음에 prefs:learn을 쓸 때 recorder가 불러오기 줄을 넣는다. ${FOLLOW}\n\n${clip(profile, "프로필")}`,
    );
}

const legacy = read(path.join(root, LEGACY_DOC));
if (legacy) {
    parts.push(
        `이 프로젝트에 옛 선호 문서(${LEGACY_DOC})가 있다. 프로필과 함께 따르고, 처음 prefs:learn을 쓸 때 recorder에게 migrate ${LEGACY_DOC}를 넘겨 프로필로 옮긴다.\n\n${clip(legacy, "옛 선호 문서")}`,
    );
}

process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: parts.join("\n\n") } })}\n`,
);
