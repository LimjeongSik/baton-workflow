// test 플러그인의 detect.mjs 테스트.
// 임시 git 저장소를 만들어 러너 감지, 추천 러너, __tests__ 경로 계산을 확인한다.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";

const DETECT = path.resolve(import.meta.dirname, "../plugins/test/skills/write/scripts/detect.mjs");

const tmpRoots = [];
after(() => tmpRoots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function makeRepo(committed, pending = {}) {
    const root = mkdtempSync(path.join(tmpdir(), "test-detect-"));
    tmpRoots.push(root);
    const write = (tree) => {
        for (const [rel, content] of Object.entries(tree)) {
            mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
            writeFileSync(path.join(root, rel), content);
        }
    };
    const git = (...args) => execFileSync("git", args, { cwd: root, env: gitEnv });
    git("init", "-q");
    write(committed);
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", "init");
    write(pending);
    return root;
}

function detect(root, ...args) {
    const result = spawnSync(process.execPath, [DETECT, ...args], { cwd: root, encoding: "utf8", env: gitEnv });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

const pkg = (deps = {}, devDeps = {}, scripts = {}) => JSON.stringify({ scripts, dependencies: deps, devDependencies: devDeps });

describe("러너 감지", () => {
    test("설치된 vitest를 감지한다", () => {
        const root = makeRepo({ "package.json": pkg({ react: "19" }, { vitest: "^3" }, { test: "vitest run" }), "pnpm-lock.yaml": "" });
        const result = detect(root);
        assert.equal(result.runner.name, "vitest");
        assert.equal(result.recommended, null);
        assert.equal(result.project.packageManager, "pnpm");
        assert.equal(result.project.addDevCommand, "pnpm add -D");
        assert.equal(result.project.testScript, "vitest run");
    });

    test("playwright만 있으면 유닛 러너보다 뒤로 둔다", () => {
        const root = makeRepo({ "package.json": pkg({}, { "@playwright/test": "1", jest: "29" }) });
        assert.equal(detect(root).runner.name, "jest");
    });

    test("node --test 스크립트를 러너로 본다", () => {
        const root = makeRepo({ "package.json": pkg({}, {}, { test: "node --test" }) });
        assert.equal(detect(root).runner.name, "node:test");
    });

    test("러너가 없으면 웹 React는 jsdom 환경의 vitest를 추천한다", () => {
        const root = makeRepo({ "package.json": pkg({ react: "19", next: "16" }) });
        const result = detect(root);
        assert.equal(result.runner, null);
        assert.deepEqual(result.recommended, { name: "vitest", environment: "jsdom" });
    });

    test("러너가 없으면 Node 서버는 node 환경의 vitest를 추천한다", () => {
        const root = makeRepo({ "package.json": pkg({ express: "5" }) });
        assert.deepEqual(detect(root).recommended, { name: "vitest", environment: "node" });
    });

    test("Expo는 jest-expo preset의 jest를 추천한다", () => {
        const root = makeRepo({ "package.json": pkg({ expo: "53", "react-native": "0.79", react: "19" }) });
        assert.deepEqual(detect(root).recommended, { name: "jest", preset: "jest-expo" });
    });

    test("Go는 내장 러너를 쓴다", () => {
        const root = makeRepo({ "go.mod": "module x\n" });
        const result = detect(root);
        assert.equal(result.project.language, "go");
        assert.equal(result.runner.name, "go test");
    });
});

describe("대상 파일", () => {
    test("변경된 소스마다 같은 폴더의 __tests__ 경로를 계산한다", () => {
        const root = makeRepo(
            { "package.json": pkg(), "src/lib/format.ts": "export const a = 1;\n" },
            {
                "src/lib/format.ts": "export const a = 2;\n",
                "src/components/Button.tsx": "export {};\n",
                "src/lib/types.ts": "export type A = 1;\n",
                "src/lib/index.ts": "export {};\n",
                "src/lib/env.d.ts": "declare const x: 1;\n",
                "README.md": "# x\n",
            },
        );
        const { targets } = detect(root);
        assert.deepEqual(targets.map((t) => [t.source, t.testPath]), [
            ["src/components/Button.tsx", "src/components/__tests__/Button.test.tsx"],
            ["src/lib/format.ts", "src/lib/__tests__/format.test.ts"],
        ]);
    });

    test("이미 있는 테스트를 existing으로 알려준다", () => {
        const root = makeRepo(
            { "package.json": pkg(), "src/a.ts": "1\n", "src/__tests__/a.test.ts": "x\n", "src/b.ts": "1\n", "src/b.spec.ts": "x\n" },
            { "src/a.ts": "2\n", "src/b.ts": "2\n" },
        );
        const { targets, layout } = detect(root);
        assert.deepEqual(targets.find((t) => t.source === "src/a.ts").existing, ["src/__tests__/a.test.ts"]);
        assert.deepEqual(targets.find((t) => t.source === "src/b.ts").existing, ["src/b.spec.ts"]);
        assert.equal(layout.inTestsFolder, 1);
        assert.equal(layout.colocated, 1);
    });

    test("경로를 주면 변경 여부와 상관없이 그 폴더를 대상으로 한다", () => {
        const root = makeRepo({ "package.json": pkg(), "src/lib/a.ts": "1\n", "src/lib/b.ts": "1\n", "src/other/c.ts": "1\n" });
        const { targets } = detect(root, "src/lib");
        assert.deepEqual(targets.map((t) => t.source), ["src/lib/a.ts", "src/lib/b.ts"]);
    });

    test("--base로 커밋된 변경도 포함한다", () => {
        const root = makeRepo({ "package.json": pkg() });
        mkdirSync(path.join(root, "src"));
        writeFileSync(path.join(root, "src/new.ts"), "1\n");
        execFileSync("git", ["add", "-A"], { cwd: root, env: gitEnv });
        execFileSync("git", ["commit", "-q", "-m", "new"], { cwd: root, env: gitEnv });
        assert.deepEqual(detect(root).targets, []);
        assert.deepEqual(detect(root, "--base", "HEAD~1").targets.map((t) => t.source), ["src/new.ts"]);
    });
});
