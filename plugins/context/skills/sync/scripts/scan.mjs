#!/usr/bin/env node
// 프로젝트를 훑어 CLAUDE.md 구성을 판단할 사실만 JSON으로 출력한다. 파일을 고치지 않는다.
//
// - stack:      Tailwind·TypeScript·프레임워크 사용 여부, import 별칭, 테스트 배치, 패키지 매니저와 검사 스크립트
// - claudeMd:   있는 CLAUDE.md 목록, 루트 목록에 적혔는데 파일이 없는 것(dangling), 파일은 있는데 목록에 없는 것(unlisted)
// - candidates: 하위 CLAUDE.md를 둘 만한 폴더 (소스 파일 수 기준, CLAUDE.md 유무 표시)
//
// 사용법: node scan.mjs [저장소 루트] [--min-files N]

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const minIndex = args.indexOf("--min-files");
const MIN_FILES = minIndex >= 0 ? Number(args[minIndex + 1]) || 5 : 5;
const positional = args.filter((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--min-files");
const root = path.resolve(positional[0] ?? gitRoot(process.cwd()) ?? process.cwd());

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".py", ".go", ".rs", ".kt", ".swift", ".java", ".rb", ".php", ".dart"]);
const IGNORED_DIRS = new Set(["node_modules", ".git", ".next", ".nuxt", ".turbo", ".vercel", "dist", "build", "out", "coverage", ".expo", "ios", "android", "vendor", "target", "__pycache__", ".venv", "venv"]);
// 사용처 하위 전용 폴더(_components 등)와 테스트 폴더는 부모 폴더의 일부로 본다
const isPrivateDir = (name) => name.startsWith("_") || name === "__tests__" || name === "__mocks__";
const MAX_DEPTH = 5;

function gitRoot(cwd) {
    try {
        return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
        return null;
    }
}

function readJson(file) {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return null;
    }
}

// tsconfig·jsconfig는 주석과 끝 쉼표를 허용한다. 문자열 안은 건드리지 않고 지운다.
function readJsonc(file) {
    let text;
    try {
        text = readFileSync(file, "utf8");
    } catch {
        return null;
    }
    let out = "";
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
            out += text.slice(i, j + 1);
            i = j;
        } else if (c === "/" && text[i + 1] === "/") {
            while (i < text.length && text[i] !== "\n") i++;
            out += "\n";
        } else if (c === "/" && text[i + 1] === "*") {
            const end = text.indexOf("*/", i + 2);
            i = end < 0 ? text.length : end + 1;
        } else {
            out += c;
        }
    }
    try {
        return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
    } catch {
        return null;
    }
}

function walk(dir, depth, visit) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".github") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (IGNORED_DIRS.has(entry.name) || depth >= MAX_DEPTH + 3) continue;
            visit(full, entry, depth);
            walk(full, depth + 1, visit);
        } else if (entry.isFile()) {
            visit(full, entry, depth);
        }
    }
}

const rel = (p) => path.relative(root, p).split(path.sep).join("/");

// ---------- 파일 수집 ----------
const files = [];
walk(root, 0, (full, entry) => {
    if (entry.isFile()) files.push(rel(full));
});

// ---------- 스택 ----------
const pkg = readJson(path.join(root, "package.json"));
const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
const has = (name) => Object.hasOwn(deps, name);

const cssImportsTailwind = files
    .filter((f) => f.endsWith(".css"))
    .slice(0, 50)
    .some((f) => /@import\s+["']tailwindcss["']|@tailwind\s+(base|components|utilities)/.test(readFileSync(path.join(root, f), "utf8")));
const tailwindConfig = files.find((f) => /^tailwind\.config\.(js|cjs|mjs|ts)$/.test(f)) ?? null;
const tailwind = has("tailwindcss") || has("@tailwindcss/postcss") || has("@tailwindcss/vite") || Boolean(tailwindConfig) || cssImportsTailwind
    ? { used: true, version: deps.tailwindcss ?? deps["@tailwindcss/postcss"] ?? deps["@tailwindcss/vite"] ?? null, config: tailwindConfig }
    : { used: false };

const tsconfig = readJsonc(path.join(root, "tsconfig.json")) ?? readJsonc(path.join(root, "jsconfig.json"));
const aliases = Object.fromEntries(
    Object.entries(tsconfig?.compilerOptions?.paths ?? {}).map(([key, targets]) => [key, targets]),
);

const frameworks = ["next", "react", "react-native", "expo", "vue", "nuxt", "svelte", "@sveltejs/kit", "astro", "@remix-run/react", "express", "fastify", "@nestjs/core", "hono"].filter(has);
// react-native 프로젝트도 react를 가지므로 앱 판정을 먼저 한다
const platform = has("react-native") || has("expo") ? "app" : ["next", "react", "vue", "nuxt", "svelte", "@sveltejs/kit", "astro", "@remix-run/react"].some(has) ? "web" : null;
const libs = {
    state: ["zustand", "jotai", "recoil", "@reduxjs/toolkit", "redux", "mobx", "valtio", "pinia", "xstate"].filter(has),
    network: ["@tanstack/react-query", "@tanstack/vue-query", "swr", "@apollo/client", "urql", "@trpc/client", "axios", "ky"].filter(has),
    navigation: ["expo-router", "@react-navigation/native", "@react-navigation/native-stack", "@react-navigation/stack", "@react-navigation/bottom-tabs"].filter(has),
    reactCompiler: has("babel-plugin-react-compiler"),
};

const testFiles = files.filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f));
const tests = {
    total: testFiles.length,
    inTestsFolder: testFiles.filter((f) => f.includes("/__tests__/")).length,
    colocated: testFiles.filter((f) => !f.includes("/__tests__/") && !/^(tests?|e2e)\//.test(f)).length,
    topLevel: testFiles.filter((f) => /^(tests?|e2e)\//.test(f)).length,
    runner: ["vitest", "jest", "@playwright/test", "mocha"].filter(has),
};

const lockfiles = { "pnpm-lock.yaml": "pnpm", "yarn.lock": "yarn", "bun.lock": "bun", "bun.lockb": "bun", "package-lock.json": "npm" };
const packageManager = Object.entries(lockfiles).find(([file]) => existsSync(path.join(root, file)))?.[1] ?? (pkg ? "npm" : null);
const scripts = Object.fromEntries(
    Object.entries(pkg?.scripts ?? {}).filter(([name]) => /^(dev|build|start|lint|typecheck|type-check|tsc|test|test:.*|e2e|format)$/.test(name)),
);

// 파일명 관례 표본: 실제 코드가 기본 규칙과 다른지 판단하는 근거
const componentFiles = files.filter((f) => /\.(tsx|jsx|vue|svelte)$/.test(f) && !/\.(test|spec|stories)\./.test(f) && !/(^|\/)(page|layout|loading|error|not-found|route|template|default)\.[jt]sx$/.test(f));
const naming = {
    componentsPascal: componentFiles.filter((f) => /^[A-Z]/.test(path.basename(f))).length,
    componentsOther: componentFiles.filter((f) => !/^[A-Z]/.test(path.basename(f))).length,
    kebabFiles: files.filter((f) => SOURCE_EXT.has(path.extname(f)) && /^[a-z0-9]+(-[a-z0-9]+)+\./.test(path.basename(f))).length,
    privateDirs: [...new Set(files.flatMap((f) => f.split("/").slice(0, -1).filter((part) => part.startsWith("_"))))].sort(),
};

// ---------- CLAUDE.md ----------
const claudeFiles = files.filter((f) => path.basename(f) === "CLAUDE.md").sort();
const nested = claudeFiles.filter((f) => f !== "CLAUDE.md");
const rootText = existsSync(path.join(root, "CLAUDE.md")) ? readFileSync(path.join(root, "CLAUDE.md"), "utf8") : null;
const listed = rootText ? [...new Set([...rootText.matchAll(/`([^`\s]+\/CLAUDE\.md)`/g)].map((m) => m[1].replace(/^\.\//, "")))] : [];
const claudeMd = {
    root: rootText === null ? null : { lines: rootText.split("\n").length },
    nested: nested.map((f) => ({ path: f, lines: readFileSync(path.join(root, f), "utf8").split("\n").length })),
    dangling: listed.filter((f) => !existsSync(path.join(root, f))),
    unlisted: nested.filter((f) => !listed.includes(f)),
    agentsMd: files.filter((f) => path.basename(f) === "AGENTS.md"),
};

// ---------- 후보 폴더 ----------
// 폴더마다 "자기 + 전용 하위 폴더(_components, __tests__ 등)"의 소스 파일 수를 센다.
const ownCount = new Map();
for (const f of files) {
    if (!SOURCE_EXT.has(path.extname(f))) continue;
    const parts = f.split("/").slice(0, -1);
    while (parts.length && isPrivateDir(parts[parts.length - 1])) parts.pop();
    const dir = parts.join("/");
    if (!dir || parts.length > MAX_DEPTH) continue;
    ownCount.set(dir, (ownCount.get(dir) ?? 0) + 1);
}
const subtreeCount = (dir) => [...ownCount].filter(([d]) => d === dir || d.startsWith(`${dir}/`)).reduce((sum, [, n]) => sum + n, 0);
const candidates = [...ownCount.keys()]
    .flatMap((dir) => dir.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/")))
    .filter((dir, i, all) => all.indexOf(dir) === i)
    .map((dir) => ({ dir, files: ownCount.get(dir) ?? 0, subtree: subtreeCount(dir), hasClaudeMd: claudeFiles.includes(`${dir}/CLAUDE.md`) }))
    .filter((c) => c.files >= MIN_FILES || c.hasClaudeMd)
    .sort((a, b) => a.dir.localeCompare(b.dir));

// ---------- 출력 ----------
const isDir = (p) => {
    try {
        return statSync(path.join(root, p)).isDirectory();
    } catch {
        return false;
    }
};

process.stdout.write(
    `${JSON.stringify(
        {
            root,
            stack: {
                tailwind,
                typescript: has("typescript") || existsSync(path.join(root, "tsconfig.json")),
                frameworks,
                platform,
                libs,
                aliases,
                srcDir: isDir("src"),
                tests,
                naming,
                packageManager,
                scripts,
            },
            claudeMd,
            candidates,
            minFiles: MIN_FILES,
        },
        null,
        2,
    )}\n`,
);
