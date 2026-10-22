// prefs 플러그인의 session-load.mjs 테스트.
// 임시 설정 폴더와 git 저장소를 만들어 학습 안내를 항상 넣는지, learn/이 없으면 빈 양식으로 만드는지, 프로젝트 루트 learn/learned.md만 넣고 전역 프로필은 넣지 않는지,
// 옛 프로젝트 선호 문서와 옛 전역 학습 파일을 옮기라고 알리는지, 길이 제한을 지키는지 확인한다.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";

const HOOK = path.resolve(import.meta.dirname, "../plugins/prefs/hooks/session-load.mjs");

const tmpRoots = [];
after(() => tmpRoots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const baseEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
delete baseEnv.DOCS_PREFERENCES_PATH;

function makeDir(files = {}, { git = false } = {}) {
    const root = mkdtempSync(path.join(tmpdir(), "prefs-hook-"));
    tmpRoots.push(root);
    if (git) execFileSync("git", ["init", "-q"], { cwd: root, env: baseEnv });
    for (const [rel, content] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), content);
    }
    return root;
}

function run({ config = makeDir(), repo = makeDir({}, { git: true }), env = {} } = {}) {
    const result = spawnSync(process.execPath, [HOOK], {
        cwd: repo,
        input: JSON.stringify({ cwd: repo }),
        encoding: "utf8",
        env: { ...baseEnv, CLAUDE_CONFIG_DIR: config, ...env },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
}

const PROFILE = "# 사용자 작업 방식 프로필\n\n## 디자인 스타일\n- [확정] 카드 그림자 대신 1px 테두리로 면을 나눈다.\n";

describe("학습 안내 주입", () => {
    test("프로필이 없어도 스스로 학습하라는 안내를 넣는다", () => {
        const context = run();
        assert.match(context, /스스로 학습한다/);
        assert.match(context, /prefs:learn/);
        assert.match(context, /learn\//);
        assert.match(context, /아직 학습한 지시문\(learn\/learned\.md\)이 없다/);
    });

    test("git 저장소에 learn/이 없으면 빈 양식으로 만들고 이미 있으면 건드리지 않는다", () => {
        const repo = makeDir({}, { git: true });
        assert.match(run({ repo }), /빈 양식/);
        assert.ok(existsSync(path.join(repo, "learn/observed.md")));
        const learned = readFileSync(path.join(repo, "learn/learned.md"), "utf8");
        assert.match(learned, /## 코드 패턴/);
        assert.doesNotMatch(learned, /YYYY-MM-DD/);
        writeFileSync(path.join(repo, "learn/learned.md"), PROFILE);
        const context = run({ repo });
        assert.doesNotMatch(context, /빈 양식/);
        assert.match(context, /1px 테두리/);
    });

    test("learn/을 만들 때 .gitignore에 /learn/을 넣고 한 번만 넣는다", () => {
        const repo = makeDir({ ".gitignore": "node_modules" }, { git: true });
        assert.match(run({ repo }), /\.gitignore에 \/learn\/을 넣었다/);
        assert.equal(readFileSync(path.join(repo, ".gitignore"), "utf8"), "node_modules\n\n# prefs 플러그인 학습 파일\n/learn/\n");
        rmSync(path.join(repo, "learn"), { recursive: true });
        assert.doesNotMatch(run({ repo }), /\.gitignore에/);
        assert.equal(readFileSync(path.join(repo, ".gitignore"), "utf8").match(/\/learn\//g).length, 1);
    });

    test(".gitignore가 없으면 만들고, 이미 있는 learn/은 .gitignore에 넣지 않는다", () => {
        const repo = makeDir({}, { git: true });
        run({ repo });
        assert.equal(readFileSync(path.join(repo, ".gitignore"), "utf8"), "# prefs 플러그인 학습 파일\n/learn/\n");
        const shared = makeDir({ "learn/learned.md": PROFILE }, { git: true });
        run({ repo: shared });
        assert.ok(!existsSync(path.join(shared, ".gitignore")));
    });

    test("git 저장소가 아니면 learn/을 만들지 않는다", () => {
        const dir = makeDir();
        run({ repo: dir });
        assert.ok(!existsSync(path.join(dir, "learn")));
    });

    test("모노레포에서는 실행한 폴더에 learn/을 만들고 git 최상위에는 만들지 않는다", () => {
        const repo = makeDir({ "frontend/.keep": "" }, { git: true });
        assert.match(run({ repo: path.join(repo, "frontend") }), /빈 양식/);
        assert.ok(existsSync(path.join(repo, "frontend/learn/learned.md")));
        assert.ok(!existsSync(path.join(repo, "learn")));
    });

    test("실행한 폴더의 learn/만 쓰고 상위 폴더의 learn/은 쓰지 않는다", () => {
        const repo = makeDir({ "learn/learned.md": PROFILE, "frontend/.keep": "", "backend/learn/learned.md": PROFILE }, { git: true });
        assert.match(run({ repo }), /1px 테두리/);
        assert.match(run({ repo: path.join(repo, "backend") }), /1px 테두리/);
        assert.doesNotMatch(run({ repo: path.join(repo, "frontend") }), /1px 테두리/);
    });

    test("다른 프로젝트의 learn/learned.md는 넣지 않는다", () => {
        makeDir({ "learn/learned.md": PROFILE }, { git: true });
        assert.doesNotMatch(run(), /1px 테두리/);
    });

    test("전역 프로필은 넣지 않고 옛 전역 학습 파일을 옮기라고 알린다", () => {
        const config = makeDir({ "prefs/profile.md": PROFILE, "prefs/signals.md": "- 2026-10-21 | x | 작업 방식 | 행동 | y\n" });
        writeFileSync(
            path.join(config, "CLAUDE.md"),
            `<!-- prefs:start -->\n@${path.join(config, "prefs/profile.md")}\n<!-- prefs:end -->\n`,
        );
        const repo = makeDir({}, { git: true });
        const context = run({ config, repo });
        assert.doesNotMatch(context, /1px 테두리/);
        assert.match(context, /migrate-global/);
        assert.match(context, new RegExp(path.basename(repo)));
    });

    test("옛 전역 학습 파일이 없으면 migrate-global을 알리지 않는다", () => {
        assert.doesNotMatch(run(), /migrate-global/);
    });

    test("옛 프로젝트 선호 문서가 있으면 내용을 넣고 migrate를 알린다", () => {
        const repo = makeDir({ "docs/PREFERENCES.md": "- [확정] 보고는 표 하나로.\n", "src/.keep": "" }, { git: true });
        const context = run({ repo: path.join(repo, "src") });
        assert.match(context, /보고는 표 하나로/);
        assert.match(context, /migrate docs\/PREFERENCES\.md/);
    });

    test("DOCS_PREFERENCES_PATH로 옛 문서 경로를 바꿀 수 있다", () => {
        const repo = makeDir({ "notes/prefs.md": "- [확정] 보고는 표 하나로.\n" }, { git: true });
        assert.doesNotMatch(run({ repo }), /표 하나로/);
        assert.match(run({ repo, env: { DOCS_PREFERENCES_PATH: "notes/prefs.md" } }), /표 하나로/);
    });

    test("너무 긴 프로필은 잘라서 넣고 그 사실을 알린다", () => {
        const repo = makeDir({ "learn/learned.md": PROFILE + "- [추정] 긴 항목\n".repeat(2000) }, { git: true });
        const context = run({ repo });
        assert.ok(context.length < 9500);
        assert.match(context, /잘랐다/);
    });
});
