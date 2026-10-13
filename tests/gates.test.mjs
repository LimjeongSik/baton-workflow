// review와 security 플러그인의 커밋·푸시 게이트 테스트.
// 실행: node --test tests/
//
// 각 테스트는 임시 git 저장소를 만들고, 훅에 PreToolUse 입력을 넣어 허용/거부를 확인한다.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";

const PLUGINS = path.resolve(import.meta.dirname, "../plugins");

const GATES = [
    {
        name: "review",
        hook: path.join(PLUGINS, "review/hooks/guard-git.mjs"),
        mark: path.join(PLUGINS, "review/skills/codex/scripts/mark-passed.mjs"),
        envPrefix: "REVIEW_GATE",
        stateFile: "codex-review/reviewed.json",
    },
    {
        name: "security",
        hook: path.join(PLUGINS, "security/hooks/guard-git.mjs"),
        mark: path.join(PLUGINS, "security/skills/sign-off/scripts/mark-passed.mjs"),
        envPrefix: "SECURITY_GATE",
        stateFile: "security-audit/passed.json",
    },
];

const tmpRoots = [];
after(() => tmpRoots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tempDir(prefix) {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    tmpRoots.push(dir);
    return dir;
}

// review 게이트는 codex가 없으면 거부 대신 확인(ask)을 낸다. 가짜 codex를 PATH 앞에 둔다.
const fakeBin = tempDir("fake-bin-");
writeFileSync(path.join(fakeBin, "codex"), "#!/bin/sh\nexit 0\n");
chmodSync(path.join(fakeBin, "codex"), 0o755);
const pathWithoutCodex = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((dir) => dir && !existsSync(path.join(dir, "codex")))
    .join(path.delimiter);

const baseEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(REVIEW_GATE|SECURITY_GATE|GIT_)/.test(key))),
    PATH: `${fakeBin}${path.delimiter}${pathWithoutCodex}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
};

function makeRepo() {
    const root = tempDir("gate-repo-");
    const git = (...args) => execFileSync("git", args, { cwd: root, env: baseEnv, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    const write = (rel, content) => {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), content);
    };
    return { root, git, write };
}

// 훅을 실행해 "allow" | "deny" | "ask"와 사유를 돌려준다.
function runHook(gate, root, command, { env = {}, cwd = root } = {}) {
    const result = spawnSync(process.execPath, [gate.hook], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }),
        env: { ...baseEnv, ...env },
        encoding: "utf8",
    });
    assert.equal(result.status, 0, `훅이 비정상 종료했습니다: ${result.stderr}`);
    if (!result.stdout.trim()) return { decision: "allow", reason: "" };
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    return { decision: output.permissionDecision, reason: output.permissionDecisionReason };
}

function mark(gate, root, ...args) {
    return spawnSync(process.execPath, [gate.mark, ...args], { cwd: root, env: baseEnv, encoding: "utf8" });
}

for (const gate of GATES) {
    describe(`${gate.name} 게이트: commit`, () => {
        test("통과 기록이 없는 소스 변경은 커밋을 막는다", () => {
            const repo = makeRepo();
            repo.write("src/a.js", "x = 1\n");
            const { decision, reason } = runHook(gate, repo.root, "git add src/a.js && git commit -m t");
            assert.equal(decision, "deny");
            assert.match(reason, /src\/a\.js/);
        });

        test("문서·에셋만 바뀐 커밋은 막지 않는다", () => {
            const repo = makeRepo();
            repo.write("README.md", "# doc\n");
            repo.write("assets/logo.svg", "<svg/>\n");
            assert.equal(runHook(gate, repo.root, "git add -A && git commit -m docs").decision, "allow");
        });

        test("통과를 기록한 뒤에는 커밋을 허용한다", () => {
            const repo = makeRepo();
            repo.write("src/a.js", "x = 1\n");
            assert.equal(mark(gate, repo.root).status, 0);
            assert.equal(runHook(gate, repo.root, "git add src/a.js && git commit -m t").decision, "allow");
        });

        test("기록한 뒤 파일을 고치면 다시 막는다", () => {
            const repo = makeRepo();
            repo.write("src/a.js", "x = 1\n");
            repo.git("add", "src/a.js");
            repo.git("commit", "-q", "-m", "a");
            repo.write("src/a.js", "x = 2\n");
            mark(gate, repo.root);
            repo.write("src/a.js", "x = 3\n");
            assert.equal(runHook(gate, repo.root, "git commit -am t").decision, "deny");
        });

        test("commit -a는 untracked 파일을 담지 않으므로 막지 않는다", () => {
            const repo = makeRepo();
            repo.write("src/new.js", "x = 1\n");
            assert.equal(runHook(gate, repo.root, "git commit -am t").decision, "allow");
        });

        test("git add .는 untracked 파일도 담으므로 막는다", () => {
            const repo = makeRepo();
            repo.write("src/new.js", "x = 1\n");
            assert.equal(runHook(gate, repo.root, "git add . && git commit -m t").decision, "deny");
        });

        test("git add로 지정하지 않은 작업 트리 변경은 이번 커밋 대상이 아니다", () => {
            const repo = makeRepo();
            repo.write("src/passed.js", "x = 1\n");
            mark(gate, repo.root);
            repo.write("src/other.js", "y = 1\n");
            assert.equal(runHook(gate, repo.root, "git add src/passed.js && git commit -m t").decision, "allow");
        });

        test("commit에 직접 준 경로도 검사한다", () => {
            const repo = makeRepo();
            repo.write("src/a.js", "x = 1\n");
            repo.git("add", "src/a.js");
            repo.git("commit", "-q", "-m", "a");
            repo.write("src/a.js", "x = 2\n");
            assert.equal(runHook(gate, repo.root, 'git commit -m "msg with spaces" -- src/a.js').decision, "deny");
        });

        test("cd와 git -C로 바뀐 디렉터리 기준으로 경로를 해석한다", () => {
            const repo = makeRepo();
            repo.write("pkg/a.js", "x = 1\n");
            assert.equal(runHook(gate, repo.root, "cd pkg && git add a.js && git commit -m t").decision, "deny");
            assert.equal(runHook(gate, repo.root, "git -C pkg add a.js && git -C pkg commit -m t").decision, "deny");
        });

        test("git 명령이 아닌 곳에 나온 commit 문자열은 무시한다", () => {
            const repo = makeRepo();
            repo.write("src/a.js", "x = 1\n");
            assert.equal(runHook(gate, repo.root, 'echo "git commit -am t"').decision, "allow");
            assert.equal(runHook(gate, repo.root, "git status").decision, "allow");
        });

        test("merge 중의 커밋은 검사하지 않는다", () => {
            const repo = makeRepo();
            repo.write("src/a.js", "x = 1\n");
            writeFileSync(path.join(repo.root, ".git/MERGE_HEAD"), `${repo.git("rev-parse", "HEAD")}\n`);
            assert.equal(runHook(gate, repo.root, "git add -A && git commit -m merge").decision, "allow");
        });

        test("git 저장소 밖에서는 막지 않는다", () => {
            const dir = tempDir("not-a-repo-");
            assert.equal(runHook(gate, dir, "git commit -am t").decision, "allow");
        });
    });

    describe(`${gate.name} 게이트: push`, () => {
        test("원격에 없는 커밋에 기록되지 않은 소스 내용이 있으면 막는다", () => {
            const repo = makeRepo();
            repo.write("src/a.js", "x = 1\n");
            repo.git("add", "src/a.js");
            repo.git("commit", "-q", "-m", "a");
            assert.equal(runHook(gate, repo.root, "git push").decision, "deny");
        });

        test("커밋 전에 기록한 내용이면 푸시를 허용한다", () => {
            const repo = makeRepo();
            repo.write("src/a.js", "x = 1\n");
            mark(gate, repo.root);
            repo.git("add", "src/a.js");
            repo.git("commit", "-q", "-m", "a");
            assert.equal(runHook(gate, repo.root, "git push -u origin main").decision, "allow");
        });

        test("원격 브랜치 삭제는 검사하지 않는다", () => {
            const repo = makeRepo();
            repo.write("src/a.js", "x = 1\n");
            repo.git("add", "src/a.js");
            repo.git("commit", "-q", "-m", "a");
            assert.equal(runHook(gate, repo.root, "git push origin --delete old").decision, "allow");
            assert.equal(runHook(gate, repo.root, "git push origin :old").decision, "allow");
        });
    });

    describe(`${gate.name} 게이트: 끄기`, () => {
        test(`${gate.envPrefix}=0이면 모두 허용한다`, () => {
            const repo = makeRepo();
            repo.write("src/a.js", "x = 1\n");
            const env = { [gate.envPrefix]: "0" };
            assert.equal(runHook(gate, repo.root, "git add -A && git commit -m t", { env }).decision, "allow");
        });

        test(`${gate.envPrefix}_COMMIT=0이면 커밋만 허용하고 푸시는 막는다`, () => {
            const repo = makeRepo();
            repo.write("src/a.js", "x = 1\n");
            const env = { [`${gate.envPrefix}_COMMIT`]: "0" };
            assert.equal(runHook(gate, repo.root, "git add -A && git commit -m t", { env }).decision, "allow");
            repo.git("add", "-A");
            repo.git("commit", "-q", "-m", "a");
            assert.equal(runHook(gate, repo.root, "git push", { env }).decision, "deny");
        });
    });

    describe(`${gate.name} 통과 기록 스크립트`, () => {
        test("--skip에 이유가 없으면 거부한다", () => {
            const repo = makeRepo();
            const result = mark(gate, repo.root, "--skip", "");
            assert.equal(result.status, 2);
        });

        test("--skip 이유를 기록에 남긴다", () => {
            const repo = makeRepo();
            repo.write("src/a.js", "x = 1\n");
            assert.equal(mark(gate, repo.root, "--skip", "포매터 결과만 포함").status, 0);
            const state = JSON.parse(readFileSync(path.join(repo.root, ".git", gate.stateFile), "utf8"));
            assert.equal(state.history.at(-1).skipped, "포매터 결과만 포함");
            assert.equal(runHook(gate, repo.root, "git add -A && git commit -m t").decision, "allow");
        });

        test("git 저장소 밖에서는 실패한다", () => {
            assert.equal(mark(gate, tempDir("not-a-repo-")).status, 2);
        });
    });
}

describe("review 게이트: codex가 없을 때", () => {
    test("막지 않고 사용자에게 확인을 받는다", () => {
        const repo = makeRepo();
        repo.write("src/a.js", "x = 1\n");
        const { decision } = runHook(GATES[0], repo.root, "git add -A && git commit -m t", {
            env: { PATH: pathWithoutCodex },
        });
        assert.equal(decision, "ask");
    });
});

describe("두 게이트 동시 사용", () => {
    test("한쪽만 기록하면 다른 쪽 게이트가 막는다", () => {
        const [review, security] = GATES;
        const repo = makeRepo();
        repo.write("src/a.js", "x = 1\n");
        mark(security, repo.root);
        const command = "git add -A && git commit -m t";
        assert.equal(runHook(security, repo.root, command).decision, "allow");
        assert.equal(runHook(review, repo.root, command).decision, "deny");
        mark(review, repo.root);
        assert.equal(runHook(review, repo.root, command).decision, "allow");
    });
});

// 플러그인은 따로 설치되므로 게이트 코드를 복사해 둔다. 복사본이 어긋나면 한쪽에만 버그 수정이 들어간 것이다.
describe("복사된 게이트 코드 동기화", () => {
    const read = (rel) => readFileSync(path.join(PLUGINS, rel), "utf8");
    const between = (source, start, end) => {
        const from = source.indexOf(start);
        const to = source.indexOf(end, from);
        assert.ok(from >= 0 && to > from, `구간을 찾을 수 없습니다: ${start} ~ ${end}`);
        return source.slice(from, to);
    };

    test("git 명령 해석부가 같다", () => {
        const start = "// 셸 명령을";
        const end = "const howToFix";
        assert.equal(
            between(read("security/hooks/guard-git.mjs"), start, end),
            between(read("review/hooks/guard-git.mjs"), start, end),
        );
    });

    test("소스 판정 목록이 같다", () => {
        const start = "const NON_SOURCE_EXTENSIONS";
        const end = "function stateFile";
        assert.equal(
            between(read("security/lib/audit-state.mjs"), start, end),
            between(read("review/lib/review-state.mjs"), start, end),
        );
    });

    test("변경 수집 로직이 같다", () => {
        const start = "function worktreeHash";
        assert.equal(
            between(read("security/lib/audit-state.mjs"), start, "export function unaudited"),
            between(read("review/lib/review-state.mjs"), start, "export function unreviewed"),
        );
    });
});
