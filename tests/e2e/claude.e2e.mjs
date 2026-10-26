// 실제 Claude Code(`claude -p`)로 플러그인을 띄워 보는 E2E 테스트. API 비용이 들므로 BATON_E2E=1일 때만 실행한다.
//
//   BATON_E2E=1 node --test tests/e2e/
//
// 단위 테스트가 확인하지 못하는 것: 플러그인 로딩, hooks.json 연결, Claude Code가 넘기는 실제 훅 입력,
// PreToolUse deny가 실제로 명령을 막는지, SessionStart 훅이 실제로 실행되는지.
// 이미 설치된 baton 플러그인은 --settings로 이 세션에서만 끄고, 저장소의 플러그인을 --plugin-dir로 불러온다.
// 모델은 BATON_E2E_MODEL(기본 haiku), 세션당 비용 상한은 BATON_E2E_BUDGET(기본 0.5달러).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";

const enabled = process.env.BATON_E2E === "1";
const PLUGINS = path.resolve(import.meta.dirname, "../../plugins");
const BATON_PLUGINS = ["all", "review", "security", "git", "feature", "refactor", "progress", "ui", "context", "test", "prefs", "biome", "baton"];

const tmpRoots = [];
after(() => tmpRoots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(REVIEW_GATE|SECURITY_GATE|BATON_MODE|GIT_)/.test(key))),
    BATON_BACKSTOP: "0",
    GIT_AUTHOR_NAME: "e2e",
    GIT_AUTHOR_EMAIL: "e2e@example.com",
    GIT_COMMITTER_NAME: "e2e",
    GIT_COMMITTER_EMAIL: "e2e@example.com",
};

function makeRepo() {
    const root = mkdtempSync(path.join(tmpdir(), "baton-e2e-"));
    tmpRoots.push(root);
    const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    const write = (rel, content) => {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), content);
    };
    return { root, git, write };
}

function claude(root, prompt, plugins) {
    const disabled = Object.fromEntries(BATON_PLUGINS.map((name) => [`${name}@baton`, false]));
    const result = spawnSync(
        "claude",
        [
            "-p",
            prompt,
            "--model",
            process.env.BATON_E2E_MODEL ?? "haiku",
            "--max-budget-usd",
            process.env.BATON_E2E_BUDGET ?? "0.5",
            "--output-format",
            "json",
            "--no-session-persistence",
            "--allowedTools",
            "Bash",
            "--settings",
            JSON.stringify({ enabledPlugins: disabled }),
            ...plugins.flatMap((name) => ["--plugin-dir", path.join(PLUGINS, name)]),
        ],
        { cwd: root, env, encoding: "utf8", timeout: 240_000 },
    );
    assert.equal(result.status, 0, `claude 실행 실패: ${result.stderr || result.stdout}`);
    return JSON.parse(result.stdout).result ?? "";
}

const COMMIT_PROMPT =
    "Run exactly this one shell command with the Bash tool, do not change it and do not run anything else: " +
    "git add -A && git commit -m e2e. Then reply with one line: COMMITTED if it succeeded, BLOCKED: <reason> if it was blocked.";

describe("실제 Claude Code에서", { skip: !enabled && "BATON_E2E=1일 때만 실행한다 (API 비용)" }, () => {
    test("리뷰·보안 게이트가 통과하지 않은 커밋을 실제로 막는다", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "export const a = 1;\n");
        const reply = claude(repo.root, COMMIT_PROMPT, ["review", "security"]);
        assert.equal(repo.git("rev-list", "--count", "HEAD"), "1", `커밋이 만들어졌습니다. 응답: ${reply}`);
        assert.match(reply, /BLOCKED|리뷰|감사|review|audit/i);
    });

    test("통과를 기록하면 같은 커밋을 허용한다", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "export const a = 1;\n");
        for (const script of ["review/skills/codex/scripts/mark-passed.mjs", "security/skills/sign-off/scripts/mark-passed.mjs"]) {
            execFileSync(process.execPath, [path.join(PLUGINS, script), "--auto"], { cwd: repo.root, env });
        }
        const reply = claude(repo.root, COMMIT_PROMPT, ["review", "security"]);
        assert.equal(repo.git("rev-list", "--count", "HEAD"), "2", `커밋되지 않았습니다. 응답: ${reply}`);
    });

    test("SessionStart 훅(prefs)이 실제로 실행되어 learn/을 만든다", () => {
        const repo = makeRepo();
        claude(repo.root, "Reply with the single word OK. Do not use any tools.", ["prefs"]);
        assert.ok(existsSync(path.join(repo.root, "learn/learned.md")), "learn/learned.md가 없습니다");
    });
});
