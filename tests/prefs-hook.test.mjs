// prefs 플러그인의 session-load.mjs 테스트.
// 임시 설정 폴더와 git 저장소를 만들어 학습 안내를 항상 넣는지, 프로필을 CLAUDE.md가 불러오지 않을 때만 직접 넣는지,
// 옛 프로젝트 선호 문서를 옮기라고 알리는지, 길이 제한을 지키는지 확인한다.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
        assert.match(context, /아직 학습된 프로필이 없다/);
    });

    test("CLAUDE.md가 프로필을 불러오지 않으면 프로필 내용을 직접 넣는다", () => {
        const config = makeDir({ "prefs/profile.md": PROFILE });
        assert.match(run({ config }), /1px 테두리/);
    });

    test("CLAUDE.md가 프로필을 불러오면 내용을 다시 넣지 않는다", () => {
        const config = makeDir({ "prefs/profile.md": PROFILE });
        writeFileSync(
            path.join(config, "CLAUDE.md"),
            `# 내 규칙\n\n<!-- prefs:start -->\n@${path.join(config, "prefs/profile.md")}\n<!-- prefs:end -->\n`,
        );
        const context = run({ config });
        assert.match(context, /이미 불러왔다/);
        assert.doesNotMatch(context, /1px 테두리/);
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
        const config = makeDir({ "prefs/profile.md": PROFILE + "- [추정] 긴 항목\n".repeat(2000) });
        const context = run({ config });
        assert.ok(context.length < 9500);
        assert.match(context, /잘랐다/);
    });
});
