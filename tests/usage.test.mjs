// baton 플러그인 usage.mjs 테스트: 가짜 설정 폴더에 transcript를 만들어 토큰 합계, 중복 제거, 서브에이전트, codex·게이트 집계를 확인한다.
// 실행: node --test tests/

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const USAGE = path.resolve(import.meta.dirname, "../plugins/baton/scripts/usage.mjs");
const tmpRoots = [];
after(() => tmpRoots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const tempDir = (prefix) => {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    tmpRoots.push(dir);
    return dir;
};

const usage = (input, output) => ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 });
const assistant = (id, model, content, at) => ({ type: "assistant", timestamp: at, message: { id, model, usage: usage(10, 50), content } });
const result = (toolUseId, content, isError, at) => ({ type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] } });
const jsonl = (entries) => `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;

test("토큰을 메시지 단위로 한 번만 세고, 서브에이전트·codex·게이트를 따로 집계한다", () => {
    const config = tempDir("config-");
    const project = tempDir("project-");
    const dir = path.join(config, "projects", project.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(path.join(dir, "s1/subagents"), { recursive: true });
    writeFileSync(
        path.join(dir, "s1.jsonl"),
        jsonl([
            // 같은 메시지가 블록마다 두 줄로 기록된 경우
            assistant("m1", "opus", [{ type: "text", text: "hi" }], "2026-10-26T00:00:00Z"),
            assistant("m1", "opus", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: 'bash "${CLAUDE_SKILL_DIR}/scripts/run-codex.sh"' } }], "2026-10-26T00:00:00Z"),
            result("t1", "리뷰 완료", false, "2026-10-26T00:02:00Z"),
            assistant("m2", "opus", [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "echo '# bash run-codex.sh 사용법'" } }], "2026-10-26T00:03:00Z"),
            result("t2", "리뷰를 통과하지 않은 소스 변경이 있어 커밋할 수 없습니다", true, "2026-10-26T00:03:01Z"),
            result("t2", "출력에 리뷰를 통과하지 않은 이라는 문구가 섞임", false, "2026-10-26T00:03:02Z"),
            assistant("m3", "opus", [{ type: "tool_use", id: "t3", name: "Skill", input: { skill: "git:ship" } }], "2026-10-26T00:10:00Z"),
        ]),
    );
    writeFileSync(path.join(dir, "s1/subagents/agent-a.jsonl"), jsonl([assistant("x1", "sonnet", [], "2026-10-26T00:05:00Z")]));
    writeFileSync(path.join(dir, "s1/subagents/agent-a.meta.json"), JSON.stringify({ agentType: "feature:tester", description: "목록 테스트" }));

    const run = spawnSync(process.execPath, [USAGE, "--cwd", project, "--json"], { env: { ...process.env, CLAUDE_CONFIG_DIR: config }, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.deepEqual(report.models.opus, { calls: 3, input: 30, output: 150, cacheWrite: 300, cacheRead: 3000 });
    assert.equal(report.subagents.length, 1);
    assert.equal(report.subagents[0].type, "feature:tester");
    assert.equal(report.subagents[0].output, 50);
    assert.equal(report.codex.runs, 1);
    assert.equal(report.codex.minutes, 2);
    assert.equal(report.gateDenials, 1);
    assert.equal(report.skills["git:ship"], 1);
    assert.equal(report.wallMinutes, 10);
});

test("transcript가 없는 폴더면 실패한다", () => {
    const run = spawnSync(process.execPath, [USAGE, "--cwd", tempDir("none-")], { env: { ...process.env, CLAUDE_CONFIG_DIR: tempDir("config-") }, encoding: "utf8" });
    assert.equal(run.status, 2);
});
