#!/usr/bin/env node
// 의존성 변경 점검 (감사 J절). 이번에 올라갈 변경(원격에 없는 커밋 + 미커밋 변경)에서 매니페스트·lockfile이 바뀌었을 때만 동작한다.
//
//   node deps.mjs [--offline] [--json]
//
// 1. 새로 들어오거나 버전이 바뀐 패키지 (package.json, requirements*.txt, pyproject.toml, go.mod, Cargo.toml)
// 2. 새 패키지 중 설치 스크립트가 있는 것 (package-lock.json의 hasInstallScript)
// 3. 유명 패키지와 이름이 한두 글자 다른 패키지 (타이포스쿼팅 의심)
// 4. 설치된 취약점 검사 도구 실행: osv-scanner, npm/pnpm/bun audit, pip-audit, cargo audit, govulncheck
//    이 단계만 네트워크를 쓴다 (취약점 DB에 패키지 이름·버전을 보낸다). --offline 또는 SECURITY_DEPS_SCAN=0이면 건너뛴다.
// 도구가 없거나 실패하면 "확인 못 함"으로 적는다. 실패를 "취약점 없음"으로 바꾸지 않는다.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { git, lines, repoRoot, shipBase, snapshotTree, tryGit } from "../../../lib/audit-state.mjs";

const args = process.argv.slice(2);
const offline = args.includes("--offline") || process.env.SECURITY_DEPS_SCAN === "0";
const root = repoRoot(process.cwd());
if (!root) {
    console.error("git 저장소가 아닙니다.");
    process.exit(2);
}

const MANIFEST = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|Gemfile(\.lock)?|composer\.(json|lock))$/;

// 타이포스쿼팅 비교용으로 자주 쓰는 패키지 이름
const POPULAR = [
    "react", "react-dom", "react-native", "next", "vue", "nuxt", "svelte", "angular", "express", "koa", "fastify", "axios",
    "lodash", "underscore", "moment", "dayjs", "date-fns", "zod", "yup", "joi", "typescript", "webpack", "vite", "rollup",
    "esbuild", "babel", "eslint", "prettier", "jest", "vitest", "mocha", "chai", "dotenv", "cors", "helmet", "jsonwebtoken",
    "bcrypt", "bcryptjs", "uuid", "nanoid", "chalk", "commander", "yargs", "inquirer", "debug", "request", "node-fetch",
    "cross-env", "rimraf", "glob", "mkdirp", "fs-extra", "socket.io", "mongoose", "prisma", "sequelize", "pg", "mysql2",
    "redis", "ioredis", "graphql", "apollo-server", "tailwindcss", "postcss", "sass", "styled-components", "zustand",
    "redux", "mobx", "rxjs", "three", "d3", "openai", "@anthropic-ai/sdk", "stripe", "firebase", "aws-sdk", "sharp",
    "requests", "numpy", "pandas", "django", "flask", "fastapi", "pydantic", "sqlalchemy", "urllib3", "boto3", "pillow",
    "serde", "tokio", "reqwest", "clap", "rand",
];

function distance(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 3;
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let prev = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const temp = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = temp;
        }
    }
    return row[b.length];
}

const show = (ref, file) => (ref ? tryGit(root, "show", `${ref}:${file}`) : null);

// 매니페스트 내용에서 { 이름: 버전 }을 뽑는다
function parseDeps(file, text) {
    const deps = {};
    if (!text) return deps;
    const base = path.basename(file);
    try {
        if (base === "package.json") {
            const json = JSON.parse(text);
            for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
                Object.assign(deps, json[section] ?? {});
            }
        } else if (base.startsWith("requirements")) {
            for (const line of lines(text)) {
                const match = line.trim().match(/^([A-Za-z0-9_.-]+)\s*([=<>!~].*)?$/);
                if (match && !line.trim().startsWith("#")) deps[match[1].toLowerCase()] = (match[2] ?? "*").trim();
            }
        } else if (base === "pyproject.toml") {
            for (const match of text.matchAll(/^\s*"([A-Za-z0-9_.-]+)\s*([=<>!~][^"]*)?"/gm)) deps[match[1].toLowerCase()] = (match[2] ?? "*").trim();
        } else if (base === "go.mod") {
            for (const match of text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+(v[^\s]+)/gm)) deps[match[1]] = match[2];
        } else if (base === "Cargo.toml") {
            const section = text.split(/^\[/m).filter((part) => /^(dev-|build-)?dependencies\]/.test(part)).join("\n");
            for (const match of section.matchAll(/^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/gm)) deps[match[1]] = match[2] ?? match[3];
        }
    } catch {}
    return deps;
}

function installScripts(tree, names) {
    const lock = names.length ? show(tree, "package-lock.json") : null;
    if (!lock) return [];
    try {
        const packages = JSON.parse(lock).packages ?? {};
        return names.filter((name) => Object.entries(packages).some(([key, info]) => key.endsWith(`node_modules/${name}`) && info.hasInstallScript));
    } catch {
        return [];
    }
}

function runTool(label, command, toolArgs, parse) {
    const which = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
    if (which.status !== 0) return null;
    const result = spawnSync(command, toolArgs, { cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    if (result.error) return { tool: label, status: "실패", detail: String(result.error.message) };
    try {
        return { tool: label, ...parse(result.stdout, result.status) };
    } catch {
        return { tool: label, status: "실패", detail: (result.stderr || result.stdout).trim().split("\n")[0]?.slice(0, 200) ?? `종료 코드 ${result.status}` };
    }
}

const countSeverity = (items) => {
    const counts = { critical: 0, high: 0, moderate: 0, low: 0 };
    for (const severity of items) {
        const key = String(severity).toLowerCase().replace("medium", "moderate");
        if (key in counts) counts[key] += 1;
    }
    return counts;
};

function vulnerabilityScans(changedFiles) {
    const results = [];
    const has = (pattern) => changedFiles.some((file) => pattern.test(file));
    const tool = (...attempt) => {
        const result = runTool(...attempt);
        if (result) results.push(result);
        return result;
    };
    // osv-scanner가 있으면 모든 생태계를 한 번에 본다
    if (tool("osv-scanner", "osv-scanner", ["scan", "source", "-r", "--format", "json", "."], (out) => {
        const severities = JSON.parse(out).results?.flatMap((r) => r.packages ?? []).flatMap((p) => p.vulnerabilities ?? []).map((v) => v.database_specific?.severity ?? "moderate") ?? [];
        return { status: "완료", counts: countSeverity(severities) };
    })) return results;

    if (has(/(package(-lock)?\.json|npm-shrinkwrap\.json)$/) && existsSync(path.join(root, "package-lock.json"))) {
        tool("npm audit", "npm", ["audit", "--json", "--omit=dev"], (out) => ({ status: "완료", counts: countSeverity(Object.values(JSON.parse(out).vulnerabilities ?? {}).map((v) => v.severity)) }));
    }
    if (has(/(package\.json|pnpm-lock\.yaml)$/) && existsSync(path.join(root, "pnpm-lock.yaml"))) {
        tool("pnpm audit", "pnpm", ["audit", "--json", "--prod"], (out) => ({ status: "완료", counts: countSeverity(Object.values(JSON.parse(out).advisories ?? {}).map((v) => v.severity)) }));
    }
    if (has(/(package\.json|bun\.lockb?)$/) && (existsSync(path.join(root, "bun.lock")) || existsSync(path.join(root, "bun.lockb")))) {
        tool("bun audit", "bun", ["audit", "--json"], (out) => ({ status: "완료", counts: countSeverity(Object.values(JSON.parse(out)).flat().map((v) => v.severity)) }));
    }
    if (has(/(requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?)$/)) {
        tool("pip-audit", "pip-audit", ["-f", "json", "--progress-spinner", "off"], (out) => {
            const vulns = JSON.parse(out).dependencies?.flatMap((d) => d.vulns ?? []) ?? [];
            return { status: "완료", counts: countSeverity(vulns.map(() => "high")), detail: vulns.length ? `${vulns.length}건 (pip-audit은 심각도를 주지 않아 high로 셈)` : undefined };
        });
    }
    if (has(/Cargo\.(toml|lock)$/)) {
        tool("cargo audit", "cargo-audit", ["audit", "--json"], (out) => ({ status: "완료", counts: countSeverity((JSON.parse(out).vulnerabilities?.list ?? []).map((v) => v.advisory?.cvss ? "high" : "moderate")) }));
    }
    if (has(/go\.(mod|sum)$/)) {
        tool("govulncheck", "govulncheck", ["-format", "json", "./..."], (out) => ({ status: "완료", counts: countSeverity((out.match(/"finding"/g) ?? []).map(() => "high")) }));
    }
    return results;
}

const base = shipBase(root);
const tree = snapshotTree(root);
const changedFiles = lines(git(root, "diff", "--name-only", base, tree)).filter((file) => MANIFEST.test(file) && !file.includes("node_modules/"));
const baseRef = base === "4b825dc642cb6eb9a060e54bf8d69288fbee4904" ? null : base;

const report = { changedFiles, added: [], changed: [], installScripts: [], lookalikes: [], scans: [], offline };
for (const file of changedFiles) {
    const before = parseDeps(file, show(baseRef, file));
    const after = parseDeps(file, show(tree, file));
    for (const [name, version] of Object.entries(after)) {
        if (!(name in before)) report.added.push({ file, name, version });
        else if (before[name] !== version) report.changed.push({ file, name, from: before[name], to: version });
    }
}
const addedNames = [...new Set(report.added.map((dep) => dep.name))];
report.installScripts = installScripts(tree, addedNames);
for (const name of addedNames) {
    const bare = name.replace(/^@[^/]+\//, "");
    const near = POPULAR.find((popular) => popular !== name && popular !== bare && distance(bare, popular.replace(/^@[^/]+\//, "")) <= (popular.length > 5 ? 2 : 1));
    if (near) report.lookalikes.push({ name, similarTo: near });
}
if (changedFiles.length && !offline) report.scans = vulnerabilityScans(changedFiles);

if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
}
if (changedFiles.length === 0) {
    console.log("의존성 변경 없음: 매니페스트·lockfile이 바뀌지 않았습니다.");
    process.exit(0);
}
const out = [`바뀐 의존성 파일: ${changedFiles.join(", ")}`];
out.push(report.added.length ? `새 패키지: ${report.added.map((d) => `${d.name}@${d.version}`).join(", ")}` : "새 패키지: 없음");
if (report.changed.length) out.push(`버전 변경: ${report.changed.map((d) => `${d.name} ${d.from} → ${d.to}`).join(", ")}`);
if (report.installScripts.length) out.push(`설치 스크립트가 있는 새 패키지: ${report.installScripts.join(", ")} (postinstall 등에서 무엇을 하는지 확인)`);
if (report.lookalikes.length) out.push(`이름이 유명 패키지와 비슷함: ${report.lookalikes.map((d) => `${d.name} ≈ ${d.similarTo}`).join(", ")} (오타·가짜 패키지인지 확인)`);
if (offline) {
    out.push("취약점 DB 조회: 건너뜀 (--offline 또는 SECURITY_DEPS_SCAN=0)");
} else if (report.scans.length === 0) {
    out.push("취약점 DB 조회: 확인 못 함 (설치된 검사 도구 없음. osv-scanner를 설치하면 모든 생태계를 봅니다)");
} else {
    for (const scan of report.scans) {
        if (scan.status !== "완료") out.push(`취약점 DB 조회 (${scan.tool}): 확인 못 함 - ${scan.detail}`);
        else out.push(`취약점 DB 조회 (${scan.tool}): critical ${scan.counts.critical} · high ${scan.counts.high} · moderate ${scan.counts.moderate} · low ${scan.counts.low}${scan.detail ? ` (${scan.detail})` : ""}`);
    }
}
console.log(out.join("\n"));
