// context 플러그인의 scan.mjs 테스트.
// 임시 프로젝트를 만들어 스택 감지, CLAUDE.md 목록 대조, 후보 폴더 계산을 확인한다.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";

const SCAN = path.resolve(import.meta.dirname, "../plugins/context/skills/sync/scripts/scan.mjs");

const tmpRoots = [];
after(() => tmpRoots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function makeProject(tree) {
    const root = mkdtempSync(path.join(tmpdir(), "context-scan-"));
    tmpRoots.push(root);
    for (const [rel, content] of Object.entries(tree)) {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), content);
    }
    return root;
}

function scan(root, ...args) {
    const result = spawnSync(process.execPath, [SCAN, root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

const files = (dir, names) => Object.fromEntries(names.map((name) => [`${dir}/${name}`, "export {};\n"]));

describe("스택 감지", () => {
    test("Tailwind·별칭·테스트 배치를 감지한다", () => {
        const root = makeProject({
            "package.json": JSON.stringify({
                scripts: { dev: "next dev", lint: "eslint .", typecheck: "tsc --noEmit", postinstall: "x" },
                dependencies: { next: "16.0.0", react: "19.0.0" },
                devDependencies: { tailwindcss: "^4.1.0", typescript: "^5", vitest: "^3" },
            }),
            "pnpm-lock.yaml": "",
            // tsconfig는 주석과 끝 쉼표를 허용한다
            "tsconfig.json": '{\n  // 별칭\n  "compilerOptions": { "paths": { "@/*": ["./src/*"], }, /* x */ },\n}\n',
            "src/app/globals.css": '@import "tailwindcss";\n',
            "src/components/Button.tsx": "export {};\n",
            "src/components/__tests__/Button.test.tsx": "export {};\n",
            "src/lib/format.ts": "export {};\n",
        });
        const { stack } = scan(root);
        assert.equal(stack.tailwind.used, true);
        assert.equal(stack.tailwind.version, "^4.1.0");
        assert.equal(stack.typescript, true);
        assert.deepEqual(stack.frameworks, ["next", "react"]);
        assert.deepEqual(stack.aliases, { "@/*": ["./src/*"] });
        assert.equal(stack.srcDir, true);
        assert.equal(stack.tests.inTestsFolder, 1);
        assert.deepEqual(stack.tests.runner, ["vitest"]);
        assert.equal(stack.packageManager, "pnpm");
        assert.deepEqual(Object.keys(stack.scripts), ["dev", "lint", "typecheck"]);
        assert.equal(stack.naming.componentsPascal, 1);
    });

    test("Tailwind가 없으면 used가 false다", () => {
        const root = makeProject({
            "package.json": JSON.stringify({ dependencies: { express: "^5" } }),
            "src/server.js": "export {};\n",
        });
        const { stack } = scan(root);
        assert.deepEqual(stack.tailwind, { used: false });
        assert.deepEqual(stack.aliases, {});
    });

    test("의존성에 없어도 CSS의 Tailwind import로 감지한다", () => {
        const root = makeProject({
            "package.json": "{}",
            "app/styles.css": "@tailwind base;\n@tailwind utilities;\n",
        });
        assert.equal(scan(root).stack.tailwind.used, true);
    });

    test("package.json이 없어도 동작한다", () => {
        const root = makeProject({ "main.py": "print(1)\n" });
        const { stack } = scan(root);
        assert.equal(stack.packageManager, null);
        assert.equal(stack.tailwind.used, false);
    });
});

describe("CLAUDE.md 대조", () => {
    test("목록에 있는데 없는 파일과, 있는데 목록에 없는 파일을 찾는다", () => {
        const root = makeProject({
            "CLAUDE.md": [
                "# app",
                "## 하위 CLAUDE.md (폴더가 생기면 추가)",
                "- `src/lib/CLAUDE.md` — 도메인 로직",
                "- `src/lib/auth/CLAUDE.md` — 세션",
                "",
            ].join("\n"),
            "src/lib/CLAUDE.md": "# lib\n",
            "src/app/api/CLAUDE.md": "# api\n",
            "node_modules/pkg/CLAUDE.md": "# 무시\n",
        });
        const { claudeMd } = scan(root);
        assert.deepEqual(claudeMd.dangling, ["src/lib/auth/CLAUDE.md"]);
        assert.deepEqual(claudeMd.unlisted, ["src/app/api/CLAUDE.md"]);
        assert.deepEqual(claudeMd.nested.map((n) => n.path), ["src/app/api/CLAUDE.md", "src/lib/CLAUDE.md"]);
        assert.equal(claudeMd.root.lines, 5);
    });

    test("루트 CLAUDE.md가 없으면 root가 null이다", () => {
        const root = makeProject({ "src/a.ts": "export {};\n" });
        assert.equal(scan(root).claudeMd.root, null);
    });
});

describe("후보 폴더", () => {
    test("전용 하위 폴더와 __tests__는 부모 폴더에 합산한다", () => {
        const root = makeProject({
            ...files("src/app/sensors", ["page.tsx", "SensorTable.tsx"]),
            ...files("src/app/sensors/_components", ["Filter.tsx", "Chart.tsx"]),
            ...files("src/app/sensors/_lib", ["chartOptions.ts"]),
            ...files("src/app/sensors/__tests__", ["chartOptions.test.ts"]),
            ...files("src/lib", ["a.ts", "b.ts"]),
        });
        const { candidates } = scan(root);
        const sensors = candidates.find((c) => c.dir === "src/app/sensors");
        assert.ok(sensors, "src/app/sensors가 후보에 있어야 합니다");
        assert.equal(sensors.files, 6);
        assert.equal(sensors.hasClaudeMd, false);
        assert.ok(!candidates.some((c) => c.dir.includes("_components")));
        assert.ok(!candidates.some((c) => c.dir === "src/lib"), "파일이 기준보다 적은 폴더는 후보가 아닙니다");
    });

    test("--min-files로 기준을 바꾸고, CLAUDE.md가 있는 폴더는 항상 포함한다", () => {
        const root = makeProject({
            ...files("src/lib", ["a.ts", "b.ts"]),
            "src/tiny/CLAUDE.md": "# tiny\n",
            "src/tiny/one.ts": "export {};\n",
        });
        const { candidates } = scan(root, "--min-files", "2");
        assert.ok(candidates.some((c) => c.dir === "src/lib"));
        const tiny = candidates.find((c) => c.dir === "src/tiny");
        assert.equal(tiny.hasClaudeMd, true);
    });
});
