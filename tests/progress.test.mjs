// progress 플러그인 테스트: 세션 시작 알림(문서가 오래됨, 마지막 ship 실패)과 facts.mjs의 사실 수집.
// 실행: node --test tests/

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";

const PLUGINS = path.resolve(import.meta.dirname, "../plugins");
const HOOK = path.join(PLUGINS, "progress/hooks/session-check.mjs");
const FACTS = path.join(PLUGINS, "progress/skills/update/scripts/facts.mjs");
const STAGE = path.join(PLUGINS, "git/skills/ship/scripts/stage.mjs");

const tmpRoots = [];
after(() => tmpRoots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|DOCS_|BATON_)/.test(key))),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
};

function makeRepo(updated) {
    const root = mkdtempSync(path.join(tmpdir(), "progress-"));
    tmpRoots.push(root);
    const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
    const write = (rel, content) => {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), content);
    };
    git("init", "-q", "-b", "main");
    write("docs/PROGRESS.md", `# 진행\n> 최종 갱신: ${updated}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "docs");
    return { root, git, write };
}

const today = new Date().toLocaleDateString("sv-SE");
const hook = (root) => {
    const result = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: root }), env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput.additionalContext : "";
};
const run = (script, root, args = []) => spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: "utf8" });

describe("세션 시작 알림", () => {
    test("문서가 최신이면 아무것도 넣지 않는다", () => {
        assert.equal(hook(makeRepo(today).root), "");
    });

    test("문서가 최신이어도 마지막 git:ship 실패는 알린다", () => {
        const repo = makeRepo(today);
        repo.write("src/a.js", "x\n");
        assert.equal(run(STAGE, repo.root, ["fail", "tests", "--reason", "a.test.js 2건 실패"]).status, 0);
        const context = hook(repo.root);
        assert.match(context, /tests 단계가 실패했다 \(a\.test\.js 2건 실패/);
        assert.doesNotMatch(context, /반영되지 않은 커밋/);
    });
});

describe("facts.mjs", () => {
    test("갱신일 이후 커밋, 미커밋 변경, 검사 기록이 지금 내용과 같은지를 보인다", () => {
        const repo = makeRepo("2020-01-01");
        repo.write("src/a.js", "x\n");
        repo.git("add", "-A");
        repo.git("commit", "-q", "-m", "feat: 목록 화면");
        repo.write("src/b.js", "y\n");
        run(STAGE, repo.root, ["pass", "checks", "--cmd", "npm run lint"]);
        let facts = run(FACTS, repo.root).stdout;
        assert.match(facts, /feat: 목록 화면/);
        assert.match(facts, /커밋되지 않은 변경 \(1개\)/);
        assert.match(facts, /checks: 통과/);
        assert.match(facts, /그대로 쓸 수 있다/);

        repo.write("src/b.js", "z\n");
        facts = run(FACTS, repo.root).stdout;
        assert.match(facts, /다시 실행해서 쓴다/);
    });

    test("진행 문서가 없으면 init을 안내한다", () => {
        const repo = makeRepo(today);
        rmSync(path.join(repo.root, "docs"), { recursive: true });
        assert.match(run(FACTS, repo.root).stdout, /없음 → init/);
    });
});
