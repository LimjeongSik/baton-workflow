// 모든 플러그인의 hooks/hooks.json을 함께 설치했을 때의 통합 테스트.
// Claude Code처럼 hooks.json의 명령을 셸로 실행하고(${CLAUDE_PLUGIN_ROOT} 치환), 같은 이벤트의 훅을 모두 돌려
// 출력 형식, 결정 합치기(deny > ask > allow), 실행 순서에 따른 차이, 저장소를 건드리지 않는지를 확인한다.
// 실행: node --test tests/

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";

const PLUGINS = path.resolve(import.meta.dirname, "../plugins");
const EVENTS = new Set(["PreToolUse", "PostToolUse", "Stop", "SubagentStop", "SessionStart", "SessionEnd", "UserPromptSubmit", "Notification", "PreCompact"]);

const tmpRoots = [];
after(() => tmpRoots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const tempDir = (prefix) => {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    tmpRoots.push(dir);
    return dir;
};

const fakeBin = tempDir("fake-bin-");
writeFileSync(path.join(fakeBin, "codex"), "#!/bin/sh\nexit 0\n");
chmodSync(path.join(fakeBin, "codex"), 0o755);

const baseEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(REVIEW_GATE|SECURITY_GATE|GIT_|BATON_|CLAUDECODE|DOCS_)/.test(key))),
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    BATON_BACKSTOP: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
};

// 설치된 모든 플러그인의 훅을 이벤트별로 모은다
const registry = [];
for (const name of readdirSync(PLUGINS)) {
    const file = path.join(PLUGINS, name, "hooks/hooks.json");
    if (!existsSync(file)) continue;
    const config = JSON.parse(readFileSync(file, "utf8"));
    for (const [event, groups] of Object.entries(config.hooks ?? {})) {
        for (const group of groups) {
            for (const hook of group.hooks) registry.push({ plugin: name, event, matcher: group.matcher, ...hook });
        }
    }
}

const matches = (hook, value) => !hook.matcher || hook.matcher === "*" || new RegExp(`^(${hook.matcher})$`).test(value);

function runHook(hook, payload, { env = {}, cwd } = {}) {
    const command = hook.command.replaceAll("${CLAUDE_PLUGIN_ROOT}", path.join(PLUGINS, hook.plugin));
    const started = Date.now();
    const result = spawnSync("sh", ["-c", command], {
        cwd,
        input: JSON.stringify(payload),
        env: { ...baseEnv, CLAUDE_PLUGIN_ROOT: path.join(PLUGINS, hook.plugin), ...env },
        encoding: "utf8",
        timeout: (hook.timeout ?? 60) * 1000,
    });
    return { ...result, ms: Date.now() - started };
}

// 같은 이벤트의 훅을 모두 실행한다. order로 실행 순서를 바꿀 수 있다.
function fire(event, payload, { value, order = (list) => list, ...options } = {}) {
    const hooks = order(registry.filter((hook) => hook.event === event && matches(hook, value ?? "")));
    return hooks.map((hook) => {
        const result = runHook(hook, { hook_event_name: event, session_id: "test-session", permission_mode: "default", ...payload }, options);
        let output = null;
        if (result.stdout.trim()) output = JSON.parse(result.stdout);
        return { plugin: hook.plugin, hook, result, output };
    });
}

// Claude Code의 PreToolUse 결정 합치기: 하나라도 deny면 deny, 아니면 하나라도 ask면 ask
function mergedDecision(results) {
    const decisions = results.map((r) => r.output?.hookSpecificOutput?.permissionDecision ?? "allow");
    return decisions.includes("deny") ? "deny" : decisions.includes("ask") ? "ask" : "allow";
}

function makeRepo() {
    const root = tempDir("hooks-repo-");
    const git = (...args) => execFileSync("git", args, { cwd: root, env: baseEnv, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    const write = (rel, content) => {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), content);
    };
    return { root, git, write };
}

const bashPayload = (root, command) => ({ cwd: root, tool_name: "Bash", tool_input: { command, description: "test" }, tool_use_id: "toolu_test" });

describe("hooks.json 형식", () => {
    test("모든 훅이 알려진 이벤트, 존재하는 스크립트, 적당한 timeout을 쓴다", () => {
        assert.ok(registry.length >= 5, "훅을 찾지 못했습니다");
        for (const hook of registry) {
            assert.ok(EVENTS.has(hook.event), `${hook.plugin}: 알 수 없는 이벤트 ${hook.event}`);
            assert.equal(hook.type, "command");
            const script = hook.command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/)?.[1];
            assert.ok(script && existsSync(path.join(PLUGINS, hook.plugin, script)), `${hook.plugin}: 스크립트가 없습니다 (${hook.command})`);
            assert.ok(hook.timeout && hook.timeout <= 30, `${hook.plugin}: timeout은 30초 이하로 둔다`);
        }
    });
});

describe("PreToolUse(Bash): review·security 함께", () => {
    test("git과 무관한 명령은 모든 훅이 출력 없이 통과시킨다", () => {
        const repo = makeRepo();
        const results = fire("PreToolUse", bashPayload(repo.root, "ls -la && npm test"), { value: "Bash", cwd: repo.root });
        assert.ok(results.length >= 2);
        for (const { plugin, result } of results) {
            assert.equal(result.status, 0, `${plugin}: ${result.stderr}`);
            assert.equal(result.stdout.trim(), "", `${plugin}가 출력을 냈습니다`);
        }
    });

    test("두 게이트 모두 통과하지 않은 커밋은 deny로 합쳐지고, 각자 자기 사유를 낸다", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "x\n");
        const results = fire("PreToolUse", bashPayload(repo.root, "git add -A && git commit -m t"), { value: "Bash", cwd: repo.root });
        assert.equal(mergedDecision(results), "deny");
        for (const { plugin, output } of results) {
            assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse", plugin);
            assert.match(output.hookSpecificOutput.permissionDecisionReason, plugin === "review" ? /리뷰/ : /보안 감사/);
        }
    });

    test("한쪽 게이트가 ask여도 다른 쪽이 deny면 deny다 (codex가 없을 때)", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "x\n");
        // node·git과 codex가 같은 폴더에 있을 수 있으므로, node와 git만 담은 폴더를 따로 만든다
        const nodeOnly = tempDir("node-only-");
        symlinkSync(process.execPath, path.join(nodeOnly, "node"));
        symlinkSync(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), path.join(nodeOnly, "git"));
        const pathWithoutCodex = [nodeOnly, ...(process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir && !existsSync(path.join(dir, "codex")))].join(path.delimiter);
        const results = fire("PreToolUse", bashPayload(repo.root, "git commit -am t && git add -A && git commit -m t"), {
            value: "Bash",
            cwd: repo.root,
            env: { PATH: pathWithoutCodex },
        });
        const byPlugin = Object.fromEntries(results.map((r) => [r.plugin, r.output?.hookSpecificOutput?.permissionDecision]));
        assert.equal(byPlugin.review, "ask");
        assert.equal(byPlugin.security, "deny");
        assert.equal(mergedDecision(results), "deny");
    });

    test("실행 순서를 바꿔도 결정이 같고, 훅이 저장소 상태를 바꾸지 않는다", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "x\n");
        repo.git("add", "src/a.js");
        const before = repo.git("status", "--porcelain", "--untracked-files=all");
        const payload = bashPayload(repo.root, "git commit -m t && git push");
        const forward = fire("PreToolUse", payload, { value: "Bash", cwd: repo.root });
        const reverse = fire("PreToolUse", payload, { value: "Bash", cwd: repo.root, order: (list) => [...list].reverse() });
        assert.equal(mergedDecision(forward), mergedDecision(reverse));
        assert.equal(repo.git("status", "--porcelain", "--untracked-files=all"), before);
    });

    test("훅마다 timeout의 절반 안에 끝난다", () => {
        const repo = makeRepo();
        for (let i = 0; i < 30; i++) repo.write(`src/f${i}.js`, `export const v = ${i};\n`);
        for (const { plugin, hook, result } of fire("PreToolUse", bashPayload(repo.root, "git add -A && git commit -m t"), { value: "Bash", cwd: repo.root })) {
            assert.ok(result.ms < (hook.timeout * 1000) / 2, `${plugin}: ${result.ms}ms`);
        }
    });

    test("Bash가 아닌 도구에는 PreToolUse(Bash) 훅이 걸리지 않는다", () => {
        assert.equal(registry.filter((hook) => hook.event === "PreToolUse" && matches(hook, "Edit")).length, 0);
    });
});

describe("SessionStart: prefs·progress 함께", () => {
    const setup = () => {
        const repo = makeRepo();
        repo.write("docs/PROGRESS.md", "# 진행\n> 최종 갱신: 2020-01-01\n");
        repo.git("add", "-A");
        repo.git("commit", "-q", "-m", "docs");
        for (let i = 0; i < 3; i++) {
            repo.write(`src/w${i}.js`, `${i}\n`);
            repo.git("add", "-A");
            repo.git("commit", "-q", "-m", `work ${i}`);
        }
        return repo;
    };
    const contexts = (results) => Object.fromEntries(results.map((r) => [r.plugin, r.output?.hookSpecificOutput?.additionalContext ?? ""]));

    test("각 훅이 SessionStart 형식으로 컨텍스트를 내고, 순서와 상관없이 같은 내용을 낸다", () => {
        const config = tempDir("config-");
        const env = { CLAUDE_CONFIG_DIR: config };
        const a = setup();
        const b = setup();
        const forward = fire("SessionStart", { cwd: a.root, source: "startup" }, { value: "startup", cwd: a.root, env });
        const reverse = fire("SessionStart", { cwd: b.root, source: "startup" }, { value: "startup", cwd: b.root, env, order: (list) => [...list].reverse() });
        for (const { plugin, result, output } of [...forward, ...reverse]) {
            assert.equal(result.status, 0, `${plugin}: ${result.stderr}`);
            assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart", plugin);
        }
        const strip = (text) => text.replaceAll(a.root, "<root>").replaceAll(b.root, "<root>").replace(/\b[0-9a-f]{7,}\b/g, "<sha>");
        const [x, y] = [contexts(forward), contexts(reverse)];
        for (const plugin of Object.keys(x)) assert.equal(strip(x[plugin]), strip(y[plugin]), plugin);
        assert.match(x.progress, /반영되지 않은 커밋이 3개/);
        assert.match(x.prefs, /스스로 학습한다/);
    });

    test("compact에는 prefs만 다시 넣는다 (진행 문서 알림은 한 번이면 된다)", () => {
        const repo = setup();
        const results = fire("SessionStart", { cwd: repo.root, source: "compact" }, { value: "compact", cwd: repo.root, env: { CLAUDE_CONFIG_DIR: tempDir("config-") } });
        assert.deepEqual(results.map((r) => r.plugin), ["prefs"]);
    });
});

describe("Stop", () => {
    test("리뷰 기록이 없는 저장소에서는 막지 않는다 (opt-in)", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "x\n");
        const transcript = path.join(repo.root, "transcript.jsonl");
        writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: path.join(repo.root, "src/a.js") } }] } })}\n`);
        for (const { plugin, result } of fire("Stop", { cwd: repo.root, transcript_path: transcript, stop_hook_active: false }, { cwd: repo.root })) {
            assert.equal(result.status, 0, plugin);
            assert.equal(result.stdout.trim(), "", plugin);
        }
    });
});
