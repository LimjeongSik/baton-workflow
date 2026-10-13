// prefs 플러그인의 session-load.mjs 테스트.
// 임시 git 저장소를 만들어 선호 문서가 있을 때만 컨텍스트를 넣는지, 경로 변경과 길이 제한을 지키는지 확인한다.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";

const HOOK = path.resolve(import.meta.dirname, "../plugins/prefs/hooks/session-load.mjs");

const tmpRoots = [];
after(() => tmpRoots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
delete gitEnv.DOCS_PREFERENCES_PATH;

function makeRepo(files = {}) {
    const root = mkdtempSync(path.join(tmpdir(), "prefs-hook-"));
    tmpRoots.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root, env: gitEnv });
    for (const [rel, content] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), content);
    }
    return root;
}

function run(cwd, env = {}) {
    const result = spawnSync(process.execPath, [HOOK], {
        cwd,
        input: JSON.stringify({ cwd }),
        encoding: "utf8",
        env: { ...gitEnv, ...env },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.additionalContext : null;
}

const DOC = "# 작업 방식 선호\n\n## UI·디자인\n- [확정] 카드 그림자 대신 1px 테두리로 면을 나눈다.\n";

describe("선호 문서 주입", () => {
    test("문서가 없으면 아무것도 출력하지 않는다", () => {
        assert.equal(run(makeRepo()), null);
    });

    test("문서가 비어 있으면 아무것도 출력하지 않는다", () => {
        assert.equal(run(makeRepo({ "docs/PREFERENCES.md": "\n\n" })), null);
    });

    test("문서 내용을 컨텍스트로 넣는다", () => {
        const context = run(makeRepo({ "docs/PREFERENCES.md": DOC }));
        assert.match(context, /1px 테두리로 면을 나눈다/);
        assert.match(context, /docs\/PREFERENCES\.md/);
    });

    test("하위 폴더에서 시작해도 저장소 루트의 문서를 읽는다", () => {
        const root = makeRepo({ "docs/PREFERENCES.md": DOC, "src/app/.keep": "" });
        assert.match(run(path.join(root, "src/app")), /1px 테두리/);
    });

    test("DOCS_PREFERENCES_PATH로 경로를 바꿀 수 있다", () => {
        const root = makeRepo({ "notes/prefs.md": DOC });
        assert.equal(run(root), null);
        assert.match(run(root, { DOCS_PREFERENCES_PATH: "notes/prefs.md" }), /1px 테두리/);
    });

    test("너무 긴 문서는 잘라서 넣고 그 사실을 알린다", () => {
        const context = run(makeRepo({ "docs/PREFERENCES.md": DOC + "- [관찰] 긴 항목\n".repeat(2000) }));
        assert.ok(context.length < 9000);
        assert.match(context, /잘랐다/);
    });
});
