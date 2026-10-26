#!/usr/bin/env node
// 세션의 토큰·시간·호출 수를 transcript에서 실측한다. baton 워크플로가 어디에 비용을 쓰는지 보고 조절하는 데 쓴다.
//
//   node usage.mjs                     # 지금 폴더의 가장 최근 세션 (보통 지금 세션)
//   node usage.mjs --session <id>      # 특정 세션
//   node usage.mjs --since 2026-10-01  # 그날 이후 이 폴더의 모든 세션 합계
//   node usage.mjs --json
//
// 모델별 토큰(입력·출력·캐시 쓰기·캐시 읽기), 서브에이전트별 토큰, 도구·스킬 호출 수, codex 리뷰 횟수와 걸린 시간,
// 게이트에 막힌 횟수(검증 재시도), git:ship 단계 기록(<git-dir>/baton/runs.jsonl)을 낸다.
// transcript는 <설정 폴더>/projects/<폴더 경로를 -로 바꾼 이름>/에 있다. codex 자체의 토큰은 transcript에 없어 횟수·시간만 센다.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? (args[index + 1] ?? "") : null;
};
const cwd = path.resolve(option("--cwd") ?? process.cwd());
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
const projectDir = path.join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));

if (!existsSync(projectDir)) {
    console.error(`이 폴더의 transcript를 찾을 수 없습니다: ${projectDir}`);
    process.exit(2);
}

const sessions = readdirSync(projectDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => ({ id: name.slice(0, -6), file: path.join(projectDir, name), mtime: statSync(path.join(projectDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

let selected;
if (option("--session")) selected = sessions.filter((s) => s.id.startsWith(option("--session")));
else if (option("--since")) selected = sessions.filter((s) => s.mtime >= Date.parse(`${option("--since")}T00:00:00`));
else selected = sessions.slice(0, 1);
if (selected.length === 0) {
    console.error("해당하는 세션이 없습니다.");
    process.exit(2);
}

const readEntries = (file) =>
    readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        })
        .filter(Boolean);

const emptyTokens = () => ({ calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const addUsage = (target, usage) => {
    target.calls += 1;
    target.input += usage.input_tokens ?? 0;
    target.output += usage.output_tokens ?? 0;
    target.cacheWrite += usage.cache_creation_input_tokens ?? 0;
    target.cacheRead += usage.cache_read_input_tokens ?? 0;
};

const GATE_DENIAL = /(리뷰를 통과하지 않은|보안 감사를 통과하지 않은|게이트가 .*확인하지 못했습니다|게이트가 해석할 수 없는)/;

const report = {
    sessions: selected.map((s) => s.id),
    wallMinutes: 0,
    models: {},
    subagents: [],
    tools: {},
    skills: {},
    codex: { runs: 0, minutes: 0 },
    gateDenials: 0,
    toolErrors: 0,
    stages: [],
};

let first = Infinity;
let last = 0;
for (const session of selected) {
    let sessionFirst = Infinity;
    let sessionLast = 0;
    const seen = new Set();
    const toolStarts = new Map();
    for (const entry of readEntries(session.file)) {
        const time = Date.parse(entry.timestamp ?? "");
        if (!Number.isNaN(time)) {
            sessionFirst = Math.min(sessionFirst, time);
            sessionLast = Math.max(sessionLast, time);
        }
        const message = entry.message ?? {};
        if (entry.type === "assistant" && message.usage) {
            const key = message.id ?? entry.requestId ?? entry.uuid;
            if (!seen.has(key)) {
                seen.add(key);
                addUsage((report.models[message.model ?? "unknown"] ??= emptyTokens()), message.usage);
            }
        }
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content) {
            if (block.type === "tool_use") {
                report.tools[block.name] = (report.tools[block.name] ?? 0) + 1;
                if (block.name === "Skill" && block.input?.skill) report.skills[block.input.skill] = (report.skills[block.input.skill] ?? 0) + 1;
                // 리뷰를 실제로 실행한 경우만 센다 (bash run-codex.sh …). 스크립트를 편집·검사한 명령(bash -n 등)은 빼고 센다.
                if (block.name === "Bash" && /(^|[\n;&|]|\btime)\s*bash\s+(?!-n\b)"?[^\s"]*\/scripts\/run-codex\.sh/m.test(block.input?.command ?? "")) {
                    report.codex.runs += 1;
                    toolStarts.set(block.id, { time, codex: true });
                }
            } else if (block.type === "tool_result") {
                const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
                if (block.is_error) report.toolErrors += 1;
                // 게이트가 막으면 도구 결과가 오류로 돌아온다. 일반 출력에 같은 문구가 섞인 것은 세지 않는다.
                if (block.is_error && GATE_DENIAL.test(text)) report.gateDenials += 1;
                const start = toolStarts.get(block.tool_use_id);
                if (start?.codex && Number.isFinite(time) && Number.isFinite(start.time)) report.codex.minutes += (time - start.time) / 60000;
            }
        }
    }

    if (Number.isFinite(sessionFirst)) {
        report.wallMinutes += (sessionLast - sessionFirst) / 60000;
        first = Math.min(first, sessionFirst);
        last = Math.max(last, sessionLast);
    }

    const subagentDir = path.join(projectDir, session.id, "subagents");
    if (!existsSync(subagentDir)) continue;
    for (const name of readdirSync(subagentDir).filter((n) => n.endsWith(".jsonl"))) {
        let meta = {};
        try {
            meta = JSON.parse(readFileSync(path.join(subagentDir, name.replace(/\.jsonl$/, ".meta.json")), "utf8"));
        } catch {}
        const tokens = emptyTokens();
        const ids = new Set();
        let model = meta.model ?? null;
        for (const entry of readEntries(path.join(subagentDir, name))) {
            const message = entry.message ?? {};
            if (entry.type !== "assistant" || !message.usage) continue;
            const key = message.id ?? entry.requestId ?? entry.uuid;
            if (ids.has(key)) continue;
            ids.add(key);
            model = message.model ?? model;
            addUsage(tokens, message.usage);
        }
        if (tokens.calls > 0) report.subagents.push({ type: meta.agentType ?? "unknown", description: meta.description ?? "", model, ...tokens });
    }
}

// git:ship 단계 기록 (같은 시간대)
try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const runs = path.resolve(root, execFileSync("git", ["rev-parse", "--git-path", "baton/runs.jsonl"], { cwd: root, encoding: "utf8" }).trim());
    if (existsSync(runs)) {
        report.stages = readEntries(runs).filter((run) => {
            const time = Date.parse(run.at);
            return time >= first - 60000 && time <= last + 60000;
        });
    }
} catch {}

if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
}

const k = (n) => (n >= 10000 ? `${(n / 1000).toFixed(0)}k` : String(n));
const total = (t) => t.input + t.output + t.cacheWrite + t.cacheRead;
const out = [];
out.push(`세션 ${report.sessions.length}개 · 세션 시간 합계 ${report.wallMinutes.toFixed(0)}분`);
out.push("\n| 모델 | 호출 | 입력 | 출력 | 캐시 쓰기 | 캐시 읽기 |\n|---|---|---|---|---|---|");
for (const [model, t] of Object.entries(report.models)) out.push(`| ${model} (메인) | ${t.calls} | ${k(t.input)} | ${k(t.output)} | ${k(t.cacheWrite)} | ${k(t.cacheRead)} |`);
for (const agent of report.subagents) {
    out.push(`| ${agent.model ?? "?"} (${agent.type}: ${agent.description.slice(0, 30)}) | ${agent.calls} | ${k(agent.input)} | ${k(agent.output)} | ${k(agent.cacheWrite)} | ${k(agent.cacheRead)} |`);
}
const mainTotal = Object.values(report.models).reduce((sum, t) => sum + total(t), 0);
const subTotal = report.subagents.reduce((sum, t) => sum + total(t), 0);
if (report.subagents.length) out.push(`\n서브에이전트 ${report.subagents.length}개가 전체 토큰의 ${((subTotal / Math.max(1, mainTotal + subTotal)) * 100).toFixed(0)}%를 썼습니다.`);
const topTools = Object.entries(report.tools).sort((a, b) => b[1] - a[1]).slice(0, 8);
out.push(`도구 호출: ${topTools.map(([name, n]) => `${name} ${n}`).join(" · ") || "없음"}`);
if (Object.keys(report.skills).length) out.push(`스킬: ${Object.entries(report.skills).map(([name, n]) => `${name} ${n}`).join(" · ")}`);
out.push(`codex 리뷰: ${report.codex.runs}회${report.codex.runs ? ` · ${report.codex.minutes.toFixed(1)}분` : ""}`);
out.push(`게이트에 막힘(검증 재시도): ${report.gateDenials}회 · 도구 오류 ${report.toolErrors}회`);
if (report.stages.length) {
    out.push(`git:ship 단계: ${report.stages.map((s) => `${s.stage} ${s.status}${s.ms ? ` ${(s.ms / 1000).toFixed(0)}s` : ""}`).join(" · ")}`);
}
console.log(out.join("\n"));
