// shared/gate-core.mjs로 옮긴 게이트 강화 기능 테스트: 명령 해석 보강, 판단 불가 시 차단,
// 공백 변경 통과 승계, 위험도 판정과 자동 기록, 리뷰 델타, git 훅 백스톱, ship 단계 기록.
// 실행: node --test tests/

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";

const PLUGINS = path.resolve(import.meta.dirname, "../plugins");
const REVIEW_HOOK = path.join(PLUGINS, "review/hooks/guard-git.mjs");
const SECURITY_HOOK = path.join(PLUGINS, "security/hooks/guard-git.mjs");
const REVIEW_MARK = path.join(PLUGINS, "review/skills/codex/scripts/mark-passed.mjs");
const SECURITY_MARK = path.join(PLUGINS, "security/skills/sign-off/scripts/mark-passed.mjs");
const DELTA = path.join(PLUGINS, "review/skills/codex/scripts/delta.mjs");
const STAGE = path.join(PLUGINS, "git/skills/ship/scripts/stage.mjs");

const tmpRoots = [];
after(() => tmpRoots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tempDir(prefix) {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    tmpRoots.push(dir);
    return dir;
}

const fakeBin = tempDir("fake-bin-");
writeFileSync(path.join(fakeBin, "codex"), "#!/bin/sh\nexit 0\n");
chmodSync(path.join(fakeBin, "codex"), 0o755);

const baseEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(REVIEW_GATE|SECURITY_GATE|GIT_|BATON_|CLAUDECODE)/.test(key))),
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    BATON_BACKSTOP: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
};

function makeRepo() {
    const root = tempDir("core-repo-");
    const git = (...args) => execFileSync("git", args, { cwd: root, env: baseEnv, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    const write = (rel, content) => {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), content);
    };
    return { root, git, write };
}

function runHookRaw(hook, input, env = {}) {
    const result = spawnSync(process.execPath, [hook], { input, env: { ...baseEnv, ...env }, encoding: "utf8" });
    assert.equal(result.status, 0, `훅이 비정상 종료했습니다: ${result.stderr}`);
    if (!result.stdout.trim()) return { decision: "allow", reason: "" };
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    return { decision: output.permissionDecision, reason: output.permissionDecisionReason };
}

const runHook = (hook, root, command, env) => runHookRaw(hook, JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: root }), env);

const run = (script, root, args = [], env = {}) =>
    spawnSync(process.execPath, [script, ...args], { cwd: root, env: { ...baseEnv, ...env }, encoding: "utf8" });

describe("명령 해석 보강", () => {
    test("sh -c, bash -c, eval 안의 커밋도 검사한다", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "x = 1\n");
        assert.equal(runHook(REVIEW_HOOK, repo.root, `sh -c "git add -A && git commit -m t"`).decision, "deny");
        assert.equal(runHook(REVIEW_HOOK, repo.root, `bash -lc 'git add . && git commit -m t'`).decision, "deny");
        assert.equal(runHook(REVIEW_HOOK, repo.root, `eval "git add -A; git commit -m t"`).decision, "deny");
    });

    test("백틱과 접두 명령(env, timeout, /usr/bin/git)을 지나서도 찾는다", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "x = 1\n");
        assert.equal(runHook(SECURITY_HOOK, repo.root, "echo `git add -A && git commit -m t`").decision, "deny");
        assert.equal(runHook(SECURITY_HOOK, repo.root, "git add -A && env FOO=1 timeout 30 /usr/bin/git commit -m t").decision, "deny");
    });

    test("commit·push로 펼쳐지는 git alias도 검사한다", () => {
        const repo = makeRepo();
        repo.git("config", "alias.ci", "commit -a");
        repo.write("src/a.js", "x = 1\n");
        repo.git("add", "src/a.js");
        assert.equal(runHook(REVIEW_HOOK, repo.root, "git ci -m t").decision, "deny");
    });

    test("해석할 수 없는 형태로 commit을 부르면 확인을 받는다", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "x = 1\n");
        assert.equal(runHook(REVIEW_HOOK, repo.root, "echo t | xargs git commit -am").decision, "ask");
    });

    test("한 명령에 커밋이 여러 번 있으면 커밋마다 담길 내용을 따로 본다", () => {
        const repo = makeRepo();
        repo.write("src/new.js", "x\n");
        assert.equal(runHook(SECURITY_HOOK, repo.root, "git commit -am t && git add -A && git commit -m t").decision, "deny");
    });

    test("commit -a라도 git add로 지정한 새 파일은 검사한다", () => {
        const repo = makeRepo();
        repo.write("src/new.js", "x\n");
        assert.equal(runHook(SECURITY_HOOK, repo.root, "git add src/new.js && git commit -am t").decision, "deny");
    });

    test("커밋 메시지나 echo 안의 git 문자열은 여전히 무시한다", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "x = 1\n");
        assert.equal(runHook(REVIEW_HOOK, repo.root, 'echo "run git commit later"').decision, "allow");
        assert.equal(runHook(REVIEW_HOOK, repo.root, "git log --grep commit").decision, "allow");
    });
});

describe("판단할 수 없을 때 통과시키지 않는다", () => {
    test("훅 입력이 깨졌는데 커밋으로 보이면 막는다", () => {
        assert.equal(runHookRaw(REVIEW_HOOK, '{"tool_input": {"command": "git commit -am t"').decision, "deny");
        assert.equal(runHookRaw(SECURITY_HOOK, "not json git push").decision, "deny");
    });

    test("훅 입력이 깨졌어도 커밋·푸시와 무관하면 통과시킨다", () => {
        assert.equal(runHookRaw(REVIEW_HOOK, "not json ls -la").decision, "allow");
    });

    test("변경을 확인하다 git이 실패하면 확인을 받는다", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "x = 1\n");
        // index를 망가뜨려 git diff --cached가 실패하게 한다
        writeFileSync(path.join(repo.root, ".git/index"), "broken");
        assert.equal(runHook(REVIEW_HOOK, repo.root, "git commit -am t").decision, "ask");
    });
});

describe("공백만 바뀐 변경", () => {
    test("통과한 내용과 공백만 다르면 다시 막지 않는다", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "function a() {\n  return 1;\n}\n");
        assert.equal(run(REVIEW_MARK, repo.root).status, 0);
        repo.write("src/a.js", "function a() {\n    return 1;\n}\n\n");
        assert.equal(runHook(REVIEW_HOOK, repo.root, "git add -A && git commit -m t").decision, "allow");
    });

    test("단어가 붙거나 내용이 바뀌면 다시 막는다", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "function a() {\n  return x;\n}\n");
        run(REVIEW_MARK, repo.root);
        repo.write("src/a.js", "function a() {\n  returnx;\n}\n");
        assert.equal(runHook(REVIEW_HOOK, repo.root, "git add -A && git commit -m t").decision, "deny");
    });

    test("공백이 의미를 갖는 파일(Python 등)은 이어받지 않는다", () => {
        const repo = makeRepo();
        repo.write("src/a.py", "if x:\n    y()\nz()\n");
        run(SECURITY_MARK, repo.root);
        repo.write("src/a.py", "if x:\n    y()\n    z()\n");
        assert.equal(runHook(SECURITY_HOOK, repo.root, "git add -A && git commit -m t").decision, "deny");
    });
});

describe("위험도와 자동 기록", () => {
    test("작고 민감하지 않은 변경은 리뷰·감사를 자동으로 기록할 수 있다", () => {
        const repo = makeRepo();
        repo.write("src/format.js", "export const pad = (n) => String(n).padStart(2, '0');\n");
        assert.equal(run(REVIEW_MARK, repo.root, ["--auto"]).status, 0);
        assert.equal(run(SECURITY_MARK, repo.root, ["--auto"]).status, 0);
        const state = JSON.parse(readFileSync(path.join(repo.root, ".git/codex-review/reviewed.json"), "utf8"));
        assert.match(state.history.at(-1).auto, /risk:trivial/);
        assert.equal(runHook(REVIEW_HOOK, repo.root, "git add -A && git commit -m t").decision, "allow");
    });

    test("민감한 경로나 코드가 있으면 자동 기록을 거부한다", () => {
        const repo = makeRepo();
        repo.write("src/auth/session.js", "export const ok = 1;\n");
        assert.equal(run(REVIEW_MARK, repo.root, ["--auto"]).status, 3);
        const other = makeRepo();
        other.write("src/view.js", "el.innerHTML = input;\n");
        assert.equal(run(SECURITY_MARK, other.root, ["--auto"]).status, 3);
    });

    test("규모가 크면 리뷰는 자동으로 건너뛰지 않지만 감사는 스캔으로 기록할 수 있다", () => {
        const repo = makeRepo();
        repo.write("src/list.js", Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`).join("\n"));
        assert.equal(run(REVIEW_MARK, repo.root, ["--auto"]).status, 3);
        assert.equal(run(SECURITY_MARK, repo.root, ["--auto"]).status, 0);
    });

    test("시크릿으로 보이는 값이 있으면 감사 자동 기록을 거부한다", () => {
        const repo = makeRepo();
        repo.write("src/c.js", 'const k = "AKIAABCDEFGHIJKLMNOP";\n');
        const result = run(SECURITY_MARK, repo.root, ["--auto"]);
        assert.equal(result.status, 3);
        assert.match(result.stderr, /시크릿/);
        assert.doesNotMatch(result.stderr, /AKIAABCDEFGHIJKLMNOP/);
    });

    test("BATON_MODE=strict면 작은 변경도 자동 기록하지 않고, fast면 중간 규모도 리뷰를 건너뛴다", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "export const a = 1;\n");
        assert.equal(run(REVIEW_MARK, repo.root, ["--auto"], { BATON_MODE: "strict" }).status, 3);
        repo.write("src/list.js", Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`).join("\n"));
        assert.equal(run(REVIEW_MARK, repo.root, ["--auto"], { BATON_MODE: "fast" }).status, 0);
    });

    test("fast 모드도 민감한 변경은 낮추지 않는다", () => {
        const repo = makeRepo();
        repo.write("src/api/user.js", "export const a = 1;\n");
        assert.equal(run(SECURITY_MARK, repo.root, ["--auto"], { BATON_MODE: "fast" }).status, 3);
    });
});

describe("리뷰 델타", () => {
    const prepare = (root) => {
        const result = run(DELTA, root, ["prepare"]);
        assert.equal(result.status, 0, result.stderr);
        return Object.fromEntries(result.stdout.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    };

    test("이미 리뷰한 줄은 빼고 새로 바뀐 줄만 diff에 남긴다", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "one\ntwo\n");
        repo.write("src/b.js", "b\n");
        run(REVIEW_MARK, repo.root);
        repo.write("src/a.js", "one\ntwo\nthree\n");
        const delta = prepare(repo.root);
        try {
            assert.equal(delta.EMPTY, "0");
            assert.equal(delta.FILES, "src/a.js");
            const diff = execFileSync("git", ["diff", delta.BASE, "HEAD"], { cwd: delta.WORKTREE, encoding: "utf8" });
            assert.match(diff, /^\+three$/m);
            assert.doesNotMatch(diff, /^\+(one|two|b)$/m);
        } finally {
            run(DELTA, repo.root, ["cleanup", delta.WORKTREE]);
        }
        assert.equal(existsSync(delta.WORKTREE), false);
    });

    test("모두 리뷰했으면 비어 있다고 알린다", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "x\n");
        run(REVIEW_MARK, repo.root);
        assert.equal(prepare(repo.root).EMPTY, "1");
    });

    test("delta는 저장소 index와 브랜치를 건드리지 않는다", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "x\n");
        const head = repo.git("rev-parse", "HEAD");
        const delta = prepare(repo.root);
        run(DELTA, repo.root, ["cleanup", delta.WORKTREE]);
        assert.equal(repo.git("rev-parse", "HEAD"), head);
        assert.equal(repo.git("diff", "--cached", "--name-only"), "");
        assert.equal(repo.git("worktree", "list").split("\n").length, 1);
    });
});

describe("git 훅 백스톱", () => {
    const backstopEnv = { BATON_BACKSTOP: "1", BATON_PLUGIN_ROOTS: PLUGINS };

    test("통과를 기록할 때 설치하고, Claude Code의 커밋만 검사한다", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "x\n");
        const marked = run(REVIEW_MARK, repo.root, [], backstopEnv);
        assert.match(marked.stdout, /백스톱을 설치/);
        assert.ok(existsSync(path.join(repo.root, ".git/hooks/pre-commit")));

        repo.write("src/a.js", "y\n");
        repo.git("add", "-A");
        const commit = (env) =>
            spawnSync("git", ["commit", "-q", "-m", "t"], { cwd: repo.root, env: { ...baseEnv, ...backstopEnv, ...env }, encoding: "utf8" });
        const blocked = commit({ CLAUDECODE: "1" });
        assert.notEqual(blocked.status, 0);
        assert.match(blocked.stderr, /src\/a\.js/);
        assert.equal(commit({}).status, 0, "사람이 하는 커밋은 막지 않는다");
    });

    test("이미 있는 git 훅은 덮어쓰지 않는다", () => {
        const repo = makeRepo();
        mkdirSync(path.join(repo.root, ".git/hooks"), { recursive: true });
        writeFileSync(path.join(repo.root, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 0\n");
        repo.write("src/a.js", "x\n");
        const marked = run(SECURITY_MARK, repo.root, [], backstopEnv);
        assert.match(marked.stdout, /기존 pre-commit/);
        assert.equal(readFileSync(path.join(repo.root, ".git/hooks/pre-commit"), "utf8"), "#!/bin/sh\nexit 0\n");
    });
});

describe("ship 단계 기록", () => {
    test("같은 내용으로 통과한 단계는 건너뛰고, 내용이 바뀌면 다시 돌린다", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "x\n");
        assert.equal(run(STAGE, repo.root, ["pass", "checks", "--cmd", "npm run lint"]).status, 0);
        assert.equal(run(STAGE, repo.root, ["fail", "tests", "--reason", "a.test.js 실패"]).status, 0);
        let plan = JSON.parse(run(STAGE, repo.root, ["plan", "--json"]).stdout);
        assert.equal(plan.stages.checks.status, "passed");
        assert.equal(plan.stages.tests.status, "failed");
        assert.equal(plan.stages.tests.reason, "a.test.js 실패");

        repo.write("src/a.js", "y\n");
        plan = JSON.parse(run(STAGE, repo.root, ["plan", "--json"]).stdout);
        assert.equal(plan.stages.checks.status, "todo");
    });

    test("fail에는 원인이 필요하고, 실행 기록을 남긴다", () => {
        const repo = makeRepo();
        assert.equal(run(STAGE, repo.root, ["fail", "tests"]).status, 2);
        run(STAGE, repo.root, ["pass", "tests", "--ms", "1500"]);
        assert.match(run(STAGE, repo.root, ["log"]).stdout, /tests passed 1\.5s/);
    });

    test("계획에 위험도와 보안·리뷰 통과 상태를 함께 보인다", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "x\n");
        run(REVIEW_MARK, repo.root);
        const plan = JSON.parse(run(STAGE, repo.root, ["plan", "--json"]).stdout);
        assert.equal(plan.effective, "trivial");
        assert.equal(plan.stages.review.status, "passed");
        assert.equal(plan.stages.audit.status, "pending");
    });
});

describe("기록 형식 호환", () => {
    const stateFile = (root) => path.join(root, ".git/codex-review/reviewed.json");

    test("버전이 없는 옛 기록을 그대로 읽고, 모르는 필드는 남긴 채 저장한다", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "x\n");
        const hash = repo.git("hash-object", "src/a.js");
        mkdirSync(path.dirname(stateFile(repo.root)), { recursive: true });
        writeFileSync(stateFile(repo.root), JSON.stringify({ files: { "src/a.js": [hash] }, history: [], extra: { keep: true } }));
        assert.equal(runHook(REVIEW_HOOK, repo.root, "git add -A && git commit -m t").decision, "allow");
        repo.write("src/b.js", "y\n");
        assert.equal(run(REVIEW_MARK, repo.root).status, 0);
        const state = JSON.parse(readFileSync(stateFile(repo.root), "utf8"));
        assert.equal(state.version, 2);
        assert.deepEqual(state.extra, { keep: true });
    });

    test("더 새 버전이 쓴 기록은 덮어쓰지 않는다", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "x\n");
        mkdirSync(path.dirname(stateFile(repo.root)), { recursive: true });
        const newer = JSON.stringify({ version: 99, files: {}, history: [] });
        writeFileSync(stateFile(repo.root), newer);
        const result = run(REVIEW_MARK, repo.root);
        assert.equal(result.status, 2);
        assert.match(result.stderr, /더 새 버전/);
        assert.equal(readFileSync(stateFile(repo.root), "utf8"), newer);
    });
});

describe("의존성 점검", () => {
    const DEPS = path.join(PLUGINS, "security/skills/audit/scripts/deps.mjs");

    test("새 패키지, 이름이 비슷한 패키지, 설치 스크립트를 알려 준다", () => {
        const repo = makeRepo();
        repo.git("remote", "add", "origin", repo.root);
        repo.write("package.json", JSON.stringify({ dependencies: { react: "^18.0.0" } }));
        repo.git("add", "-A");
        repo.git("commit", "-q", "-m", "deps");
        repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
        repo.write("package.json", JSON.stringify({ dependencies: { react: "^18.3.0", lodahs: "1.0.0" } }));
        repo.write("package-lock.json", JSON.stringify({ packages: { "node_modules/lodahs": { version: "1.0.0", hasInstallScript: true } } }));
        const result = run(DEPS, repo.root, ["--offline", "--json"]);
        assert.equal(result.status, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        assert.deepEqual(report.added.map((d) => d.name), ["lodahs"]);
        assert.deepEqual(report.changed.map((d) => d.name), ["react"]);
        assert.deepEqual(report.installScripts, ["lodahs"]);
        assert.equal(report.lookalikes[0].similarTo, "lodash");
    });

    test("의존성 파일이 바뀌지 않았으면 그렇게 알린다", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "x\n");
        assert.match(run(DEPS, repo.root, ["--offline"]).stdout, /의존성 변경 없음/);
    });

    test("lockfile만 바뀌어도 민감한 변경으로 본다", () => {
        const repo = makeRepo();
        repo.write("package-lock.json", "{}\n");
        assert.equal(run(SECURITY_MARK, repo.root, ["--auto"]).status, 3);
    });
});
