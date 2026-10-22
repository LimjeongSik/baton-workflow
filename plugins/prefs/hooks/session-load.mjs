#!/usr/bin/env node
// SessionStart 훅: Claude가 이 프로젝트에서 사용자의 작업 방식을 스스로 학습하도록 안내를 넣는다.
//
// 학습 결과는 프로젝트 루트의 learn/ 폴더에 둔다. 프로젝트마다 선호 기술·패턴이 달라서 전역(~/.claude)에는 두지도 읽지도 않는다.
// 프로젝트 루트는 Claude를 실행한 폴더(cwd)다. 모노레포에서 frontend/에서 실행하면 frontend/learn/을 쓰고, 상위 폴더로 올라가지 않는다.
// git 저장소 안인데 learn/이 없으면 templates/의 빈 양식(observed.md, learned.md)으로 만들고,
// 아직 무시되지 않으면 실행한 폴더의 .gitignore에 /learn/을 넣는다. 이미 있는 learn/은 커밋하기로 한 것일 수 있어 건드리지 않는다.
// learn/learned.md에 학습한 항목이 있으면 그 내용을 직접 넣는다.
// 프로젝트에 옛 선호 문서(DOCS_PREFERENCES_PATH, 기본 docs/PREFERENCES.md)가 있으면 그 내용도 넣고 learn/으로 옮기라고 알린다.
// 옛 전역 학습 파일(<설정 폴더>/prefs/)이 남아 있으면 따르지 말고 이 프로젝트 줄만 옮기라고 알린다.
// 설정 폴더는 CLAUDE_CONFIG_DIR, 없으면 ~/.claude다.
// 차단하지 않는다. 판단할 수 없으면 조용히 통과한다.

import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
const GLOBAL_DIR = path.join(CONFIG_DIR, "prefs");
const IMPORT_MARK = "<!-- prefs:start -->";
const LEGACY_DOC = process.env.DOCS_PREFERENCES_PATH ?? "docs/PREFERENCES.md";
const MAX_CHARS = 8000;
const TEMPLATES = path.join(import.meta.dirname, "..", "templates");

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
let gitRoot = cwd;
let inGit = false;
try {
    gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    inGit = true;
} catch {}

const root = path.resolve(cwd);

const LEARN_DIR = path.join(root, "learn");
const LEARNED = path.join(LEARN_DIR, "learned.md");
let created = false;
if (inGit && !existsSync(LEARN_DIR)) {
    try {
        mkdirSync(LEARN_DIR);
        const today = new Date().toLocaleDateString("sv-SE");
        writeFileSync(LEARNED, readFileSync(path.join(TEMPLATES, "learned.md"), "utf8").replace("YYYY-MM-DD", today));
        copyFileSync(path.join(TEMPLATES, "observed.md"), path.join(LEARN_DIR, "observed.md"));
        created = true;
    } catch {}
}

let ignored = false;
if (created) {
    try {
        execFileSync("git", ["check-ignore", "-q", "learn/learned.md"], { cwd: root, stdio: "ignore" });
    } catch {
        try {
            const gitignore = path.join(root, ".gitignore");
            const raw = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
            const gap = raw === "" ? "" : raw.endsWith("\n") ? "\n" : "\n\n";
            appendFileSync(gitignore, `${gap}# prefs 플러그인 학습 파일\n/learn/\n`);
            ignored = true;
        } catch {}
    }
}

const FOLLOW = "[확정]은 묻지 않고 따르고, [추정]은 다른 근거가 없을 때만 따르고 따랐으면 보고에 밝힌다. 이번 요청이나 프로젝트 CLAUDE.md와 다르면 그쪽을 따른다.";
const parts = [
    `Claude는 이 프로젝트에서 사용자의 작업 방식을 스스로 학습한다. 프로젝트 루트는 ${root}이고, 학습 결과는 그 아래 learn/ 폴더(관찰한 신호 observed.md, 학습한 지시문 learned.md)에만 두고, 다른 프로젝트나 전역(~/.claude)의 학습 내용은 참고하지 않는다. 사용자가 시키기를 기다리지 않고, "기억해 둘까요?", "메모해 둘까요?", "선호로 기록할까요?"처럼 묻지도 않는다. 기록할지는 Claude가 판단 근거로 정한다. 작업 중 사용자가 고르거나 고친 것, 거절한 것, 일반 지시, 사용자의 행동에서 드러난 방식, 프로필대로 한 결과를 사용자가 받아들였는지 고쳤는지를 지켜보고, 작업을 마칠 때 신호가 있었다고 판단하면 prefs:learn 스킬로 넘긴다. 신호는 근거일 뿐이고, 이 프로젝트의 여러 작업에서 같은 방향이 확인된 것만 프로필 지시문이 된다.`,
];

const learned = read(LEARNED);
if (created) {
    parts.push(
        `이 프로젝트에 learn/ 폴더가 없어 빈 양식(observed.md, learned.md)으로 만들었다.${ignored ? " .gitignore에 /learn/을 넣었다." : ""}`,
    );
}
if (!/^- \[(확정|추정)\]/m.test(learned)) {
    parts.push("이 프로젝트에는 아직 학습한 지시문(learn/learned.md)이 없다. 신호가 쌓이면 recorder가 채운다.");
} else {
    parts.push(`이 프로젝트에서 학습한 지시문(learn/learned.md)이다. ${FOLLOW}\n\n${clip(learned, "학습한 지시문")}`);
}

const legacy = read(path.join(gitRoot, LEGACY_DOC));
if (legacy) {
    parts.push(
        `이 프로젝트에 옛 선호 문서(${LEGACY_DOC})가 있다. 프로필과 함께 따르고, 처음 prefs:learn을 쓸 때 recorder에게 migrate ${LEGACY_DOC}를 넘겨 learn/으로 옮긴다.\n\n${clip(legacy, "옛 선호 문서")}`,
    );
}

const globalImport = read(path.join(CONFIG_DIR, "CLAUDE.md")).includes(IMPORT_MARK);
if (globalImport || existsSync(path.join(GLOBAL_DIR, "profile.md")) || existsSync(path.join(GLOBAL_DIR, "signals.md"))) {
    parts.push(
        `옛 버전이 남긴 전역 학습 파일(${GLOBAL_DIR})이 있다. 여러 프로젝트가 섞인 내용이라 따르지 않는다. 전역 CLAUDE.md가 불러온 프로필도 이 프로젝트에서는 무시한다. 처음 prefs:learn을 쓸 때 recorder에게 migrate-global을 넘겨 이 프로젝트(${path.basename(gitRoot)})의 줄만 learn/으로 옮긴다.`,
    );
}

process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: parts.join("\n\n") } })}\n`,
);
