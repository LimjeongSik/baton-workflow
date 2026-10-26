#!/usr/bin/env node
// git pre-commit / pre-push 훅에서 실행되는 2차 방어선 (lib/gate-core.mjs의 installBackstop이 설치한 훅이 부른다).
// Claude Code가 실행한 커밋·푸시(CLAUDECODE=1)만 검사한다. PreToolUse 훅이 해석하지 못한 형태로 실행된 커밋도 잡는다.

import { gateDisabled, howToFix, runBackstop, store } from "../lib/audit-state.mjs";

process.exit(runBackstop({ name: "보안 감사", store, gateDisabled, howToFix, hook: process.argv[2] }));
