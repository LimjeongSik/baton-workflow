#!/usr/bin/env node
// Stop 훅: 이번 턴에 소스 파일을 수정했고, 리뷰를 통과하지 않은 변경이 남아 있으면 종료 전에 리뷰를 요구한다.
//
// 이 저장소에서 한 번이라도 리뷰를 받은 뒤에만 동작한다 (opt-in). CODEX_TRIAGE_GATE_STOP=0 또는 CODEX_TRIAGE_GATE=0으로 끈다.
// "이번 턴에 수정했는가"는 transcript로, "리뷰를 통과했는가"는 파일 내용 해시로 판단한다.
// 판단할 수 없는 상황(파싱 실패, codex 미설치, git 실패 등)에서는 항상 통과시킨다. 훅이 작업을 막아서는 안 된다.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
    describe,
    gateDisabled,
    hasCodexBinary,
    hasReviewHistory,
    isSource,
    pendingChanges,
    repoRoot,
    unpushedChanges,
    unreviewed,
} from "../lib/review-state.mjs";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const allow = () => process.exit(0);

// tool_result나 스킬 주입(isMeta)이 아닌, 사람이 실제로 보낸 메시지인지
function isRealUserMessage(entry) {
    if (entry.type !== "user" || entry.isMeta || entry.isSidechain) return false;
    if (entry.toolUseResult !== undefined) return false;
    const content = entry.message?.content;
    if (typeof content === "string") return true;
    return Array.isArray(content) && !content.some((block) => block.type === "tool_result");
}

function editedSourceThisTurn(transcriptPath, root) {
    const entries = readFileSync(transcriptPath, "utf8")
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

    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (isRealUserMessage(entry)) break;
        if (entry.type !== "assistant") continue;
        for (const block of entry.message?.content ?? []) {
            if (block.type !== "tool_use") continue;
            // 서브에이전트(Agent)에게 맡긴 구현도 소스 수정으로 본다
            if (block.name === "Agent" || block.name === "Task") return true;
            if (!EDIT_TOOLS.has(block.name)) continue;
            const filePath = block.input?.file_path ?? block.input?.notebook_path;
            if (!filePath) continue;
            const relative = path.relative(root, path.resolve(root, filePath));
            if (!relative.startsWith("..") && isSource(relative)) return true;
        }
    }
    return false;
}

if (gateDisabled("stop")) allow();

let input;
try {
    input = JSON.parse(readFileSync(0, "utf8"));
} catch {
    allow();
}
if (!input || input.stop_hook_active) allow();
if (!hasCodexBinary()) allow();

const root = repoRoot(input.cwd ?? process.cwd());
if (!root || !hasReviewHistory(root)) allow();

let blocked = [];
try {
    if (!input.transcript_path || !existsSync(input.transcript_path)) allow();
    if (!editedSourceThisTurn(input.transcript_path, root)) allow();
    blocked = unreviewed(root, [...pendingChanges(root), ...unpushedChanges(root)]);
} catch {
    allow();
}
if (blocked.length === 0) allow();

process.stdout.write(
    `${JSON.stringify({
        decision: "block",
        reason: [
            `리뷰를 통과하지 않은 소스 변경이 있습니다 (${describe(blocked)}).`,
            "종료하기 전에 codex-triage:review-apply 스킬로 리뷰를 받고, 각 지적을 코드로 검증해 타당한 것만 반영한 뒤 채택/기각 근거를 표로 보고하세요.",
            "아직 작업 중이라 리뷰할 단계가 아니면, 그 이유를 한 줄로 밝히고 종료해도 됩니다. 이 변경은 리뷰 전까지 커밋·푸시할 수 없습니다.",
        ].join(" "),
    })}\n`,
);
process.exit(0);
