#!/usr/bin/env node
// 테스트 하네스와 "테스트가 필요한 변경 파일"을 JSON으로 출력한다. 파일을 고치지 않는다.
//
// - runner:    설치된 테스트 러너 (없으면 null)와 추천 러너
// - project:   언어, 패키지 매니저, 프레임워크, test 스크립트, 설정 파일, 경로 별칭
// - layout:    기존 테스트 배치 (__tests__ / 같은 폴더 / 최상위 tests)
// - targets:   변경된 소스 파일마다 __tests__ 규칙에 따른 테스트 경로와 존재 여부
//
// 사용법: node detect.mjs [--base <ref>] [경로...]
//   --base <ref>  <ref>...HEAD와 작업 트리 변경을 대상으로 한다 (기본: HEAD 대비 작업 트리 변경)
//   경로          변경 여부와 상관없이 이 파일·폴더를 대상으로 한다

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const baseIndex = args.indexOf("--base");
const base = baseIndex >= 0 ? args[baseIndex + 1] : null;
const explicitPaths = args.filter((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--base");

function tryRun(cmd, cmdArgs, cwd) {
    try {
        return execFileSync(cmd, cmdArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trimEnd();
    } catch {
        return null;
    }
}

const root = tryRun("git", ["rev-parse", "--show-toplevel"], process.cwd()) ?? process.cwd();
const exists = (rel) => existsSync(path.join(root, rel));
const lines = (text) => (text ? text.split("\n").filter(Boolean) : []);

function readJson(rel) {
    try {
        return JSON.parse(readFileSync(path.join(root, rel), "utf8"));
    } catch {
        return null;
    }
}

// ---------- 프로젝트 ----------
const pkg = readJson("package.json");
const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
const has = (name) => Object.hasOwn(deps, name);

const language = pkg
    ? "js"
    : exists("pyproject.toml") || exists("requirements.txt") || exists("setup.py")
      ? "python"
      : exists("go.mod")
        ? "go"
        : exists("Cargo.toml")
          ? "rust"
          : "unknown";

const lockfiles = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"], ["package-lock.json", "npm"]];
const packageManager = lockfiles.find(([file]) => exists(file))?.[1] ?? (pkg ? "npm" : null);
const addDevCommand = { npm: "npm install -D", pnpm: "pnpm add -D", yarn: "yarn add -D", bun: "bun add -d" }[packageManager] ?? null;
const runScript = { npm: "npm run", pnpm: "pnpm", yarn: "yarn", bun: "bun run" }[packageManager] ?? null;

const frameworks = {
    react: has("react"),
    reactNative: has("react-native"),
    expo: has("expo"),
    next: has("next"),
    vite: has("vite"),
    vue: has("vue"),
    svelte: has("svelte"),
    typescript: has("typescript") || exists("tsconfig.json"),
    node: !has("react") && !has("vue") && !has("svelte") && Boolean(pkg),
};

let aliases = {};
try {
    const text = readFileSync(path.join(root, exists("tsconfig.json") ? "tsconfig.json" : "jsconfig.json"), "utf8");
    const match = text.match(/"paths"\s*:\s*(\{[^}]*\})/);
    if (match) aliases = JSON.parse(match[1].replace(/,(\s*})/g, "$1"));
} catch {
    // 별칭 없음
}

const configFiles = readdirSync(root).filter((name) =>
    /^(jest|vitest|vite|playwright|babel)\.config\.[cm]?[jt]s$|^(jest\.setup|vitest\.setup|setupTests)\.[cm]?[jt]sx?$|^(pytest\.ini|conftest\.py|\.babelrc)$/.test(name),
);

// ---------- 러너 ----------
const JS_RUNNERS = ["vitest", "jest", "mocha", "ava", "@playwright/test"];
const installed = JS_RUNNERS.filter(has).map((name) => ({ name, version: deps[name] }));
const testScript = pkg?.scripts?.test ?? null;
const usesNodeTest = Boolean(testScript && /node\s+(--test|.*\s--test)/.test(testScript));
const readText = (rel) => {
    try {
        return readFileSync(path.join(root, rel), "utf8");
    } catch {
        return "";
    }
};
const pythonRunner =
    language === "python" && (exists("pytest.ini") || exists("conftest.py") || /pytest/.test(readText("pyproject.toml") + readText("requirements.txt")))
        ? "pytest"
        : null;

let runner = null;
if (installed.length) runner = { name: installed.find((r) => r.name !== "@playwright/test")?.name ?? installed[0].name, installed };
else if (usesNodeTest) runner = { name: "node:test", installed: [] };
else if (pythonRunner) runner = { name: "pytest", installed: [] };
else if (language === "go") runner = { name: "go test", installed: [] }; // 내장
else if (language === "rust") runner = { name: "cargo test", installed: [] }; // 내장

// 러너가 없을 때 추천: RN/Expo는 jest가 사실상 표준, 나머지 JS/TS는 vitest
const recommended =
    runner
        ? null
        : language === "js"
          ? frameworks.reactNative || frameworks.expo
              ? { name: "jest", preset: frameworks.expo ? "jest-expo" : "react-native" }
              : { name: "vitest", environment: frameworks.react || frameworks.vue || frameworks.svelte ? "jsdom" : "node" }
          : language === "python"
            ? { name: "pytest" }
            : null;

// ---------- 기존 테스트 배치 ----------
const allFiles = lines(tryRun("git", ["ls-files", "--cached", "--others", "--exclude-standard"], root));
const isTestFile = (f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || /(^|\/)test_[^/]+\.py$|_test\.(py|go)$/.test(f);
const testFiles = allFiles.filter(isTestFile);
const layout = {
    total: testFiles.length,
    inTestsFolder: testFiles.filter((f) => f.includes("__tests__/")).length,
    colocated: testFiles.filter((f) => !f.includes("__tests__/") && !/^(tests?|e2e)\//.test(f)).length,
    topLevel: testFiles.filter((f) => /^(tests?|e2e)\//.test(f)).length,
    samples: testFiles.slice(0, 5),
};

// ---------- 대상 파일 ----------
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/;
const NOT_TARGET =
    /(^|\/)(__tests__|__mocks__|node_modules|dist|build|coverage|\.next)\/|\.d\.ts$|\.(test|spec|stories|config)\.[cm]?[jt]sx?$|(^|\/)(index|types?)\.[jt]s$|(^|\/)(layout|loading|not-found|error|template|default|middleware|proxy)\.[jt]sx?$/;

function changedFiles() {
    const set = new Set();
    if (base) lines(tryRun("git", ["diff", "--name-only", "--diff-filter=AM", `${base}...HEAD`], root)).forEach((f) => set.add(f));
    lines(tryRun("git", ["diff", "--name-only", "--diff-filter=AM", "HEAD"], root)).forEach((f) => set.add(f));
    lines(tryRun("git", ["ls-files", "--others", "--exclude-standard"], root)).forEach((f) => set.add(f));
    return [...set];
}

function expand(rel) {
    const full = path.join(root, rel);
    try {
        if (statSync(full).isDirectory()) return allFiles.filter((f) => f.startsWith(`${rel.replace(/\/$/, "")}/`));
    } catch {
        return [];
    }
    return [rel];
}

const candidates = explicitPaths.length ? explicitPaths.flatMap((p) => expand(path.relative(root, path.resolve(p)))) : changedFiles();
const targets = [...new Set(candidates)]
    .filter((f) => SOURCE.test(f) && !NOT_TARGET.test(f) && exists(f))
    .sort()
    .map((source) => {
        const dir = path.posix.dirname(source);
        const ext = path.posix.extname(source);
        const name = path.posix.basename(source, ext);
        const testExt = { ".mjs": ".mjs", ".cjs": ".cjs", ".vue": ".ts", ".svelte": ".ts" }[ext] ?? ext;
        const testPath = `${dir === "." ? "" : `${dir}/`}__tests__/${name}.test${testExt}`;
        const existing = [testPath, `${dir}/${name}.test${testExt}`, `${dir}/${name}.spec${testExt}`, `${dir}/__tests__/${name}.spec${testExt}`]
            .map((p) => p.replace(/^\.\//, ""))
            .filter((p) => exists(p));
        return { source, testPath, existing };
    });

process.stdout.write(
    `${JSON.stringify(
        {
            root,
            project: { language, packageManager, addDevCommand, runScript, frameworks, testScript, configFiles, aliases },
            runner,
            recommended,
            layout,
            targets,
        },
        null,
        2,
    )}\n`,
);
