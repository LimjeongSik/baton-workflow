// biome 플러그인의 setup.mjs 테스트.
// 임시 프로젝트를 만들어 종류별 biome.json 생성, .vscode 병합, 스크립트 추가를 확인한다.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";

const SETUP = path.resolve(import.meta.dirname, "../plugins/biome/skills/setup/scripts/setup.mjs");

const tmpRoots = [];
after(() => tmpRoots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function makeProject(tree, { biome = "2.5.15", git = true } = {}) {
    const root = mkdtempSync(path.join(tmpdir(), "biome-setup-"));
    tmpRoots.push(root);
    const files = { ...tree };
    if (git) files[".git/HEAD"] = "ref: refs/heads/main\n";
    if (biome) files["node_modules/@biomejs/biome/package.json"] = JSON.stringify({ version: biome });
    for (const [rel, content] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), content);
    }
    return root;
}

const pkg = (deps = {}, extra = {}) => JSON.stringify({ name: "x", dependencies: deps, devDependencies: { typescript: "5" }, ...extra }, null, 4);
const tsconfig = JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } });

function run(root, ...args) {
    const result = spawnSync(process.execPath, [SETUP, ...args], { cwd: root, encoding: "utf8" });
    return { ...result, json: result.status === 0 ? JSON.parse(result.stdout) : null };
}
const read = (root, rel) => JSON.parse(readFileSync(path.join(root, rel), "utf8"));
const flatSources = (config) => config.assist.actions.source.organizeImports.options.groups.flatMap((g) => (typeof g === "string" ? [g] : [g.source ?? []].flat()));

describe("프로젝트 종류별 biome.json", () => {
    test("Next는 next·react domain, .next 제외, react → next 그룹을 쓴다", () => {
        const root = makeProject({ "package.json": pkg({ next: "16", react: "19", tailwindcss: "4" }), "tsconfig.json": tsconfig });
        const { json } = run(root);
        const config = json.preview.biomeConfig;
        assert.equal(json.project.kind, "next");
        assert.deepEqual(config.linter.domains, { next: "recommended", react: "recommended" });
        assert.ok(config.files.includes.includes("!!**/.next"));
        assert.equal(config.css.parser.tailwindDirectives, true);
        assert.ok(config.linter.rules.a11y);
        const sources = flatSources(config);
        assert.ok(sources.indexOf("react") < sources.indexOf("next"));
        assert.ok(sources.includes("@/components/**"));
    });

    test("Expo는 DOM 규칙을 빼고 react-native·expo 그룹과 네이티브 폴더 제외를 쓴다", () => {
        const root = makeProject({ "package.json": pkg({ expo: "53", "react-native": "0.79", react: "19" }) });
        const config = run(root).json.preview.biomeConfig;
        assert.deepEqual(config.linter.domains, { react: "recommended" });
        assert.equal(config.linter.rules.a11y, undefined);
        assert.equal(config.linter.rules.security, undefined);
        assert.ok(config.files.includes.includes("!!**/ios"));
        assert.ok(config.files.includes.includes("!!**/.expo"));
        assert.equal(config.css, undefined);
        const sources = flatSources(config);
        assert.ok(sources.includes("react-native"));
        assert.ok(sources.includes("expo-*"));
        assert.ok(!sources.includes("@/components/**"), "별칭이 없으면 별칭 그룹을 만들지 않는다");
    });

    test("JS 전용 프로젝트는 type 규칙과 type 그룹을 넣지 않는다", () => {
        const root = makeProject({ "package.json": JSON.stringify({ name: "x", dependencies: { express: "5" } }) }, { git: false });
        const config = run(root).json.preview.biomeConfig;
        assert.equal(config.linter.rules.style, undefined);
        assert.equal(config.vcs, undefined);
        const groups = config.assist.actions.source.organizeImports.options.groups;
        assert.ok(groups.every((g) => typeof g === "string" || Array.isArray(g)));
    });

    test("~ 별칭은 그 이름으로 그룹을 만든다", () => {
        const root = makeProject({ "package.json": pkg({ react: "19" }), "tsconfig.json": '{ "compilerOptions": { "paths": { "~/*": ["./src/*"] } } }' });
        assert.ok(flatSources(run(root).json.preview.biomeConfig).includes("~/hooks/**"));
    });
});

describe("--write", () => {
    test("biome이 설치되어 있지 않으면 쓰지 않고 실패한다", () => {
        const root = makeProject({ "package.json": pkg({ react: "19" }) }, { biome: null });
        const result = run(root, "--write");
        assert.equal(result.status, 1);
        assert.match(result.stderr, /npm install -D -E @biomejs\/biome/);
    });

    test("설치된 버전으로 $schema를 쓰고 .vscode와 스크립트를 만든다", () => {
        const root = makeProject({ "package.json": pkg({ next: "16", react: "19" }), "bun.lock": "" }, { biome: "2.6.0" });
        const { json } = run(root, "--write");
        assert.deepEqual(json.written.sort(), [".vscode/extensions.json", ".vscode/settings.json", "biome.json", "package.json"]);
        assert.equal(read(root, "biome.json").$schema, "https://biomejs.dev/schemas/2.6.0/schema.json");
        assert.equal(read(root, ".vscode/settings.json")["[typescriptreact]"]["editor.defaultFormatter"], "biomejs.biome");
        assert.deepEqual(read(root, ".vscode/extensions.json").recommendations, ["biomejs.biome"]);
        assert.deepEqual(read(root, "package.json").scripts, { lint: "biome check", format: "biome check --write" });
        assert.match(readFileSync(path.join(root, "package.json"), "utf8"), /^ {4}"name"/m, "package.json 들여쓰기를 유지한다");
    });

    test("기존 biome.json과 다른 도구의 스크립트는 건드리지 않는다", () => {
        const root = makeProject({
            "package.json": pkg({ react: "19" }, { scripts: { lint: "eslint ." } }),
            "biome.json": '{ "formatter": { "indentWidth": 2 } }',
        });
        const { json } = run(root, "--write");
        assert.deepEqual(json.scriptConflicts, { lint: "eslint ." });
        assert.equal(read(root, "biome.json").formatter.indentWidth, 2);
        assert.equal(read(root, "package.json").scripts.lint, "eslint .");
        assert.equal(read(root, "package.json").scripts.format, "biome check --write");
        run(root, "--write", "--force");
        assert.equal(read(root, "biome.json").formatter.indentWidth, 4);
    });

    test("주석이 있는 settings.json을 병합하고 바뀐 키를 알린다", () => {
        const root = makeProject({
            "package.json": pkg({ react: "19" }),
            ".vscode/settings.json": '{\n  // 기존 설정\n  "editor.tabSize": 2,\n  "[typescript]": { "editor.defaultFormatter": "esbenp.prettier-vscode" },\n}\n',
            ".vscode/extensions.json": '{ "recommendations": ["dbaeumer.vscode-eslint"] }',
        });
        assert.deepEqual(run(root).json.plan.vscodeSettings.changed, ["[typescript]"]);
        run(root, "--write");
        const settings = read(root, ".vscode/settings.json");
        assert.equal(settings["editor.tabSize"], 2);
        assert.equal(settings["[typescript]"]["editor.defaultFormatter"], "biomejs.biome");
        assert.deepEqual(read(root, ".vscode/extensions.json").recommendations, ["dbaeumer.vscode-eslint", "biomejs.biome"]);
    });
});
