#!/usr/bin/env node
// 프로젝트 종류(Next, React, React Native, Expo 등)에 맞는 biome.json과 .vscode 설정을 만든다.
//
// - 인자 없음: 감지 결과와 만들 파일 내용(plan)을 JSON으로 출력한다. 파일을 고치지 않는다.
// - --write:   plan대로 biome.json, .vscode/settings.json, .vscode/extensions.json, package.json 스크립트를 쓴다.
//              @biomejs/biome이 설치되어 있어야 한다 ($schema 버전을 설치된 버전에 맞춘다).
// - --force:   --write와 함께 쓰면 이미 있는 biome.json(c)을 덮어쓴다.
//
// 사용법: node setup.mjs [--write] [--force]

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const write = args.includes("--write");
const force = args.includes("--force");

// git 루트가 아니라 가장 가까운 package.json 폴더가 기준이다 (모노레포 하위 앱 대응)
function findRoot(start) {
    let dir = start;
    while (true) {
        if (existsSync(path.join(dir, "package.json"))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return start;
        dir = parent;
    }
}

const root = findRoot(process.cwd());
const exists = (rel) => existsSync(path.join(root, rel));
const readText = (rel) => {
    try {
        return readFileSync(path.join(root, rel), "utf8");
    } catch {
        return null;
    }
};

// 주석과 끝 쉼표를 허용하는 JSON(JSONC) 파서. 문자열 안의 // 는 건드리지 않는다.
function parseJsonc(text) {
    let out = "";
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
            out += text.slice(i, j + 1);
            i = j;
        } else if (ch === "/" && text[i + 1] === "/") {
            while (i < text.length && text[i] !== "\n") i++;
            out += "\n";
        } else if (ch === "/" && text[i + 1] === "*") {
            i = text.indexOf("*/", i + 2) + 1;
            if (i === 0) throw new Error("닫히지 않은 주석");
        } else {
            out += ch;
        }
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const pkgText = readText("package.json");
const pkg = pkgText ? JSON.parse(pkgText) : null;
const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
const has = (name) => Object.hasOwn(deps, name);

// ---------- 프로젝트 ----------
const lockfiles = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"], ["package-lock.json", "npm"]];
const pmFromField = pkg?.packageManager?.split("@")[0];
const packageManager = lockfiles.find(([file]) => exists(file))?.[1] ?? pmFromField ?? "npm";
const installCommand = {
    npm: "npm install -D -E @biomejs/biome",
    pnpm: "pnpm add -D -E @biomejs/biome",
    yarn: "yarn add -D -E @biomejs/biome",
    bun: "bun add -d -E @biomejs/biome",
}[packageManager];
const execCommand = { npm: "npx biome", pnpm: "pnpm exec biome", yarn: "yarn biome", bun: "bunx biome" }[packageManager];
const runScript = { npm: "npm run", pnpm: "pnpm", yarn: "yarn", bun: "bun run" }[packageManager];

const kind = has("expo")
    ? "expo"
    : has("react-native")
      ? "react-native"
      : has("next")
        ? "next"
        : has("react")
          ? "react"
          : has("vue")
            ? "vue"
            : has("svelte")
              ? "svelte"
              : has("solid-js")
                ? "solid"
                : "node";
const native = kind === "expo" || kind === "react-native";
const react = native || kind === "next" || kind === "react";
const typescript = has("typescript") || exists("tsconfig.json");
const tailwind = has("tailwindcss") || has("nativewind");

// tsconfig paths에서 "@/*" 같은 와일드카드 별칭을 찾는다. src를 가리키는 별칭을 우선한다.
let aliases = {};
for (const file of ["tsconfig.json", "jsconfig.json"]) {
    const text = readText(file);
    if (!text) continue;
    try {
        aliases = parseJsonc(text).compilerOptions?.paths ?? {};
    } catch {
        // 파싱 실패: 별칭 없음으로 본다
    }
    break;
}
const wildcard = Object.entries(aliases).filter(([key]) => key.endsWith("/*"));
const mainAlias = (wildcard.find(([, targets]) => targets.some((t) => /(^|\/)src\/\*$/.test(t))) ?? wildcard[0])?.[0].slice(0, -2) ?? null;

// ---------- 기존 설정 ----------
// .git이 상위에 없으면 vcs 설정을 넣지 않는다 (Biome이 VCS 루트를 못 찾으면 경고한다)
function inGitRepo(start) {
    for (let dir = start; ; dir = path.dirname(dir)) {
        if (existsSync(path.join(dir, ".git"))) return true;
        if (path.dirname(dir) === dir) return false;
    }
}
const git = inGitRepo(root);

const biomeConfigFile = ["biome.json", "biome.jsonc"].find(exists) ?? null;
const eslintFiles = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml"].filter(exists);
const prettierFiles = [".prettierrc", ".prettierrc.json", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", ".prettierrc.yml", "prettier.config.js", "prettier.config.mjs"].filter(exists);
if (pkg?.prettier) prettierFiles.push("package.json#prettier");

function installedBiomeVersion() {
    const text = readText("node_modules/@biomejs/biome/package.json");
    if (text) return JSON.parse(text).version;
    return null;
}
const biomeVersion = installedBiomeVersion();

// ---------- biome.json ----------
function buildBiomeConfig(version) {
    const includes = ["**", "!**/*.svg"];
    if (kind === "next") includes.push("!**/next-env.d.ts", "!!**/.next", "!!**/out");
    if (kind === "expo") includes.push("!**/expo-env.d.ts", "!!**/.expo", "!!**/web-build");
    if (native) includes.push("!!**/android", "!!**/ios");
    if (has("nativewind")) includes.push("!**/nativewind-env.d.ts");
    if (["react", "vue", "svelte", "solid", "node", "expo"].includes(kind)) includes.push("!!**/dist");
    includes.push("!!**/build", "!!**/coverage", "!!**/.claude", "!!**/.superpowers");
    if (exists("package-lock.json")) includes.push("!!**/package-lock.json");

    const config = {
        $schema: `https://biomejs.dev/schemas/${version}/schema.json`,
        ...(git ? { vcs: { enabled: true, clientKind: "git", useIgnoreFile: true } } : {}),
        files: { ignoreUnknown: true, includes },
        formatter: { enabled: true, indentStyle: "space", indentWidth: 4, lineWidth: 100 },
        json: { formatter: { trailingCommas: "none" } },
    };
    if (tailwind) config.css = { parser: { tailwindDirectives: true } };
    config.javascript = {
        ...(react ? { jsxRuntime: "transparent" } : {}),
        formatter: { quoteStyle: "double", semicolons: "always", trailingCommas: "all" },
    };

    const domains = {};
    if (kind === "next") domains.next = "recommended";
    if (react) domains.react = "recommended";
    if (kind === "vue") domains.vue = "recommended";
    if (kind === "solid") domains.solid = "recommended";

    const rules = {
        preset: "recommended",
        correctness: {
            noUnusedImports: { level: "error", fix: "safe" },
            ...(react ? { useHookAtTopLevel: "error", useExhaustiveDependencies: "warn" } : {}),
        },
    };
    if (typescript) rules.style = { useImportType: { level: "error", options: { style: "separatedType" } } };
    if (react) rules.suspicious = { noArrayIndexKey: "warn" };
    // 아래 규칙은 DOM 대상이라 React Native에서는 의미가 없다
    if (react && !native) {
        rules.security = { noDangerouslySetInnerHtml: "warn" };
        rules.a11y = { useButtonType: "off", useKeyWithClickEvents: "off", useSemanticElements: "off" };
    }
    config.linter = { enabled: true, ...(Object.keys(domains).length ? { domains } : {}), rules };

    // type-only import를 맨 뒤 그룹으로 모으려면 TS일 때만 type 조건을 붙인다
    const group = (source) => (typescript ? { type: false, source } : source);
    const groups = [];
    if (native) {
        groups.push(group(["react", "react/**", "react-native", "react-native/**"]));
        if (kind === "expo") groups.push(group(["expo", "expo/**", "expo-*", "expo-*/**", "@expo/**"]));
        groups.push(":BLANK_LINE:");
    } else if (react) {
        groups.push(group(["react", "react/**", "react-dom", "react-dom/**"]));
        if (kind === "next") groups.push(group(["next", "next/**"]));
        groups.push(":BLANK_LINE:");
    }
    groups.push(group([":PACKAGE:", ":PACKAGE_WITH_PROTOCOL:"]), ":BLANK_LINE:");
    if (mainAlias) {
        const a = mainAlias;
        groups.push(
            group(`${a}/components/**`),
            ":BLANK_LINE:",
            group([`${a}/constants/**`, `${a}/hooks/**`, `${a}/lib/**`, `${a}/types/**`]),
            ":BLANK_LINE:",
            group(`${a}/**`),
            ":BLANK_LINE:",
        );
    }
    groups.push(group(["./**", "../**"]));
    if (typescript) groups.push(":BLANK_LINE:", { type: true });

    config.assist = {
        enabled: true,
        actions: { source: { organizeImports: { level: "on", options: { sortBareImports: false, groups } } } },
    };
    return config;
}

// ---------- .vscode ----------
const onSave = (formatter) => ({ "editor.defaultFormatter": formatter, "editor.formatOnSave": true, "editor.formatOnSaveMode": "file" });
const vscodeSettings = {
    "editor.formatOnSave": true,
    "[json]": onSave("vscode.json-language-features"),
    "[jsonc]": onSave("vscode.json-language-features"),
    "[javascript]": onSave("biomejs.biome"),
    "[javascriptreact]": onSave("biomejs.biome"),
    ...(typescript ? { "[typescript]": onSave("biomejs.biome"), "[typescriptreact]": onSave("biomejs.biome") } : {}),
    "editor.codeActionsOnSave": { "source.fixAll.biome": "explicit", "source.organizeImports.biome": "explicit" },
    ...(typescript ? { "js/ts.preferences.preferTypeOnlyAutoImports": true } : {}),
};

function readJsoncFile(rel) {
    const text = readText(rel);
    if (text === null) return { status: "missing", value: null };
    try {
        return { status: "ok", value: parseJsonc(text) };
    } catch (error) {
        return { status: "invalid", value: null, error: error.message };
    }
}

// 기존 settings.json에 우리 키를 덮어쓴다. 값이 달라지는 키는 changed로 알린다.
function mergeSettings(existing) {
    const merged = { ...existing };
    const changed = [];
    for (const [key, value] of Object.entries(vscodeSettings)) {
        const prev = existing[key];
        const next = prev && typeof prev === "object" && typeof value === "object" ? { ...prev, ...value } : value;
        if (prev !== undefined && JSON.stringify(prev) !== JSON.stringify(next)) changed.push(key);
        merged[key] = next;
    }
    return { merged, changed };
}

const settingsFile = readJsoncFile(".vscode/settings.json");
const extensionsFile = readJsoncFile(".vscode/extensions.json");

// ---------- package.json 스크립트 ----------
const wantedScripts = { lint: "biome check", format: "biome check --write" };
const scriptsToAdd = {};
const scriptConflicts = {};
for (const [name, command] of Object.entries(wantedScripts)) {
    const current = pkg?.scripts?.[name];
    if (current === undefined) scriptsToAdd[name] = command;
    else if (!current.includes("biome")) scriptConflicts[name] = current;
}

// ---------- plan ----------
const settingsPlan =
    settingsFile.status === "missing"
        ? { path: ".vscode/settings.json", action: "create", changed: [] }
        : settingsFile.status === "invalid"
          ? { path: ".vscode/settings.json", action: "manual", error: settingsFile.error, changed: [] }
          : { path: ".vscode/settings.json", action: "merge", changed: mergeSettings(settingsFile.value).changed };
const recommendations = extensionsFile.value?.recommendations ?? [];
const extensionsPlan = {
    path: ".vscode/extensions.json",
    action:
        extensionsFile.status === "invalid" ? "manual" : extensionsFile.status === "missing" ? "create" : recommendations.includes("biomejs.biome") ? "keep" : "merge",
};

const result = {
    root,
    project: { kind, typescript, tailwind, alias: mainAlias, packageManager, installCommand, execCommand, runScript },
    biome: { installed: biomeVersion, declared: deps["@biomejs/biome"] ?? null, existingConfig: biomeConfigFile },
    others: { eslint: eslintFiles, prettier: prettierFiles },
    plan: {
        biomeConfig: { path: biomeConfigFile ?? "biome.json", action: biomeConfigFile ? (force ? "overwrite" : "skip") : "create" },
        vscodeSettings: settingsPlan,
        vscodeExtensions: extensionsPlan,
        scripts: { add: scriptsToAdd, conflicts: scriptConflicts },
    },
    preview: {
        biomeConfig: buildBiomeConfig(biomeVersion ?? "<설치된 버전>"),
        vscodeSettings,
    },
};

if (!write) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
}

// ---------- --write ----------
if (!biomeVersion) {
    process.stderr.write(`@biomejs/biome이 설치되어 있지 않습니다. 먼저 설치하세요: ${installCommand}\n`);
    process.exit(1);
}

const written = [];
const skipped = [];
const json = (value, indent = 4) => `${JSON.stringify(value, null, indent)}\n`;
const writeFile = (rel, text) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
    written.push(rel);
};

if (!biomeConfigFile || force) writeFile(biomeConfigFile ?? "biome.json", json(buildBiomeConfig(biomeVersion)));
else skipped.push({ path: biomeConfigFile, reason: "이미 있음 (--force로 덮어쓰기)" });

if (settingsFile.status === "invalid") skipped.push({ path: ".vscode/settings.json", reason: `파싱 실패: ${settingsFile.error}` });
else writeFile(".vscode/settings.json", json(settingsFile.value ? mergeSettings(settingsFile.value).merged : vscodeSettings));

if (extensionsFile.status === "invalid") skipped.push({ path: ".vscode/extensions.json", reason: `파싱 실패: ${extensionsFile.error}` });
else if (!recommendations.includes("biomejs.biome"))
    writeFile(".vscode/extensions.json", json({ ...(extensionsFile.value ?? {}), recommendations: [...recommendations, "biomejs.biome"] }));

if (Object.keys(scriptsToAdd).length) {
    const indent = pkgText.match(/^[ \t]+(?=")/m)?.[0] ?? 2;
    writeFile("package.json", json({ ...pkg, scripts: { ...(pkg.scripts ?? {}), ...scriptsToAdd } }, indent));
}

process.stdout.write(`${JSON.stringify({ root, biomeVersion, written, skipped, scriptConflicts, settingsChanged: settingsPlan.changed }, null, 2)}\n`);
