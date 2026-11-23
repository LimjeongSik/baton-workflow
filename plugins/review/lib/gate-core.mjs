// baton 게이트 공통 코드: 변경 수집, 통과 기록, git 명령 해석, 위험도 판정, 리뷰 델타, git 훅 백스톱.
//
// 정본은 저장소 루트의 shared/gate-core.mjs다. 플러그인은 따로 설치되므로 review·security·git 플러그인의 lib/에
// 같은 파일을 복사해 둔다. 고칠 때는 정본을 고치고 `node scripts/sync-shared.mjs`로 복사한다 (테스트가 어긋남을 잡는다).
//
// 통과 기록은 파일 내용(blob 해시) 단위다. 기록 뒤에 파일이 바뀌면 공백만 바뀌었어도 다시 검사 대상이 된다
// (문자열·주석·문법을 모르는 공백 비교는 "a b" → "a  b", `return\n42` → `return 42`도 같다고 보기 때문이다).
// 통과로 기록하는 것은 검사가 실제로 본 내용, 곧 작업 트리 스냅샷뿐이다. 그와 다른 staged 내용은 기록하지 않는다.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const DELETED = "-";
const STATE_VERSION = 2;
const MAX_HASHES_PER_FILE = 20;

// ─── git ────────────────────────────────────────────────────────────────────

export function git(cwd, ...args) {
    return gitWith(cwd, args);
}

function gitWith(cwd, args, { env, input } = {}) {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: env ? { ...process.env, ...env } : process.env,
        input,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
    }).trimEnd();
}

export function tryGit(cwd, ...args) {
    try {
        return git(cwd, ...args);
    } catch {
        return null;
    }
}

export function lines(output) {
    return output ? output.split("\n").filter(Boolean) : [];
}

export function repoRoot(cwd) {
    return tryGit(cwd, "rev-parse", "--show-toplevel");
}

export function hasHead(root) {
    return tryGit(root, "rev-parse", "-q", "--verify", "HEAD") !== null;
}

// ─── 소스 판정 ──────────────────────────────────────────────────────────────

// 검사 대상이 아닌 파일: 문서, 에셋, lockfile. 실행 코드가 들어갈 수 있는 .mdx(JSX)·.svg(script)는 검사한다.
const NON_SOURCE_EXTENSIONS = new Set([
    ".md", ".markdown", ".txt", ".rst", ".adoc",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".heic",
    ".ttf", ".otf", ".woff", ".woff2", ".eot",
    ".mp3", ".mp4", ".mov", ".wav", ".webm", ".pdf", ".zip",
]);
const NON_SOURCE_FILES = new Set([
    "LICENSE", "LICENCE", "NOTICE", "CHANGELOG", "AUTHORS", "CODEOWNERS", ".gitignore", ".gitattributes",
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "Cargo.lock", "poetry.lock",
    "uv.lock", "Gemfile.lock", "composer.lock", "go.sum", "Podfile.lock",
]);
const NON_SOURCE_PREFIXES = [".design/", ".github/ISSUE_TEMPLATE/"];
// 확장자가 문서여도 에이전트의 동작을 정의하는 파일: .claude/ 아래 전부(훅 설정·스크립트·명령), 스킬·에이전트·명령·훅 정의
const BEHAVIOR_DEFINITION = /(^|\/)\.claude\/|(^|\/)(skills|agents|commands|hooks)\/.+\.(md|markdown)$/;

export function isSource(relPath) {
    if (BEHAVIOR_DEFINITION.test(relPath)) return true;
    if (NON_SOURCE_PREFIXES.some((prefix) => relPath.startsWith(prefix))) return false;
    const base = path.basename(relPath);
    if (NON_SOURCE_FILES.has(base)) return false;
    return !NON_SOURCE_EXTENSIONS.has(path.extname(base).toLowerCase());
}

// ─── 변경 수집 ──────────────────────────────────────────────────────────────

function worktreeHash(root, relPath) {
    if (!existsSync(path.join(root, relPath))) return DELETED;
    return git(root, "hash-object", "--", relPath);
}

// name-status 한 줄을 { path, deleted }로. rename(R)·copy(C)는 새 경로와 함께 옛 경로의 삭제로 본다.
function parseNameStatus(output) {
    const entries = [];
    for (const line of lines(output)) {
        const [status, ...paths] = line.split("\t");
        if (status.startsWith("R")) {
            entries.push({ path: paths[0], deleted: true }, { path: paths[1], deleted: false });
        } else if (status.startsWith("C")) {
            entries.push({ path: paths[1], deleted: false });
        } else {
            entries.push({ path: paths[0], deleted: status === "D" });
        }
    }
    return entries;
}

// 아직 커밋되지 않은 소스 변경: 커밋에 담길 수 있는 모든 내용 (index와 작업 트리 양쪽)
export function pendingChanges(root) {
    const base = hasHead(root) ? "HEAD" : EMPTY_TREE;
    const changes = [];

    // index에 올라간 내용
    for (const entry of parseNameStatus(git(root, "diff", "--cached", "--name-status", "-M", base))) {
        if (!isSource(entry.path)) continue;
        const hash = entry.deleted ? DELETED : git(root, "rev-parse", `:${entry.path}`);
        changes.push({ path: entry.path, hash, where: "staged" });
    }
    // 작업 트리 내용 (tracked 수정·삭제, untracked)
    const untracked = new Set(lines(git(root, "ls-files", "--others", "--exclude-standard")));
    const worktreePaths = new Set([
        ...parseNameStatus(git(root, "diff", "--name-status", "-M", base)).map((entry) => entry.path),
        ...untracked,
    ]);
    for (const relPath of worktreePaths) {
        if (!isSource(relPath)) continue;
        changes.push({ path: relPath, hash: worktreeHash(root, relPath), where: "worktree", untracked: untracked.has(relPath) });
    }
    return dedupe(changes);
}

// 원격에 없는 커밋들의 시작점. 없으면 null.
export function unpushedBase(root, { upstream } = {}) {
    if (!hasHead(root)) return null;
    const tracking = upstream ?? tryGit(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
    if (tracking) {
        const base = tryGit(root, "merge-base", tracking, "HEAD");
        return base && base !== git(root, "rev-parse", "HEAD") ? base : null;
    }
    const commits = lines(git(root, "rev-list", "--reverse", "HEAD", "--not", "--remotes"));
    if (commits.length === 0) return null;
    return tryGit(root, "rev-parse", "-q", "--verify", `${commits[0]}^`) ?? EMPTY_TREE;
}

// base..tip 사이에 바뀐 소스 파일의 tip 시점 내용
export function rangeChanges(root, base, tip = "HEAD") {
    const changes = [];
    for (const entry of parseNameStatus(git(root, "diff", "--name-status", "-M", base, tip))) {
        if (!isSource(entry.path)) continue;
        const hash = entry.deleted ? DELETED : git(root, "rev-parse", `${tip}:${entry.path}`);
        changes.push({ path: entry.path, hash, where: "unpushed" });
    }
    return dedupe(changes);
}

// 아직 원격에 없는 커밋들이 바꾼 소스 파일의 HEAD 시점 내용
export function unpushedChanges(root, options = {}) {
    const base = unpushedBase(root, options);
    return base ? rangeChanges(root, base, "HEAD") : [];
}

function dedupe(changes) {
    const seen = new Set();
    return changes.filter((change) => {
        const key = `${change.path}\0${change.hash}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function describe(changes, limit = 8) {
    const names = [...new Set(changes.map((change) => change.path))];
    return names.slice(0, limit).join(", ") + (names.length > limit ? ` 외 ${names.length - limit}개` : "");
}

// ─── 통과 기록 저장소 ───────────────────────────────────────────────────────

// dir: <git-dir> 아래 폴더 이름, file: 기록 파일 이름, ref: 기준점 ref (없어도 된다)
export function createStore({ dir: dirName, file: fileName, ref = null }) {
    const stateFile = (root) => {
        const dir = path.resolve(root, git(root, "rev-parse", "--git-path", dirName));
        return { dir, file: path.join(dir, fileName) };
    };

    // 버전 호환: 버전이 없으면 1(0.2.x 이하)로 보고 그대로 읽는다. files·history의 형태는 버전 사이에 바뀌지 않는다.
    // 모르는 필드는 저장할 때 그대로 둔다. 더 새 버전이 쓴 기록은 읽기만 하고 덮어쓰지 않는다 (플러그인을 되돌렸을 때 기록을 잃지 않게).
    const load = (root) => {
        let state = {};
        try {
            state = JSON.parse(readFileSync(stateFile(root).file, "utf8"));
        } catch {}
        return { ...state, version: state.version ?? 1, files: state.files ?? {}, history: state.history ?? [] };
    };

    const save = (root, state) => {
        if (state.version > STATE_VERSION) {
            throw new Error(
                `${stateFile(root).file}은 더 새 버전(${state.version})의 플러그인이 쓴 기록이라 덮어쓰지 않습니다. 플러그인을 업데이트하세요 (/baton:update).`,
            );
        }
        const { dir, file } = stateFile(root);
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, `${JSON.stringify({ ...state, version: STATE_VERSION }, null, 2)}\n`);
    };

    const isPassed = (root, change, files = load(root).files) => (files[change.path] ?? []).includes(change.hash);

    return {
        ref,
        load,
        isPassed,
        hasHistory(root) {
            return existsSync(stateFile(root).file) || (ref !== null && tryGit(root, "rev-parse", "-q", "--verify", ref) !== null);
        },
        // 통과 기록이 없는 변경만 남긴다
        unchecked(root, changes) {
            const { files } = load(root);
            return changes.filter((change) => !isPassed(root, change, files));
        },
        // 검사가 본 내용(작업 트리 스냅샷에서 원격 이후 바뀐 소스)만 통과로 기록한다. ref가 있으면 HEAD로 옮긴다.
        // 작업 트리와 다른 staged 내용이나 커밋 안의 중간 내용은 검사가 보지 않았으므로 기록하지 않는다.
        // tree·base를 넘기면 그 스냅샷을 그대로 쓴다 (위험도를 판정한 스냅샷과 같은 내용을 기록하도록).
        mark(root, { reason = null, logFile = null, auto = null, tree, base } = {}) {
            const state = load(root);
            const changes = snapshotChanges(root, { tree, base });
            for (const change of changes) {
                const hashes = state.files[change.path] ?? [];
                if (!hashes.includes(change.hash)) hashes.push(change.hash);
                state.files[change.path] = hashes.slice(-MAX_HASHES_PER_FILE);
            }
            const head = hasHead(root) ? git(root, "rev-parse", "HEAD") : null;
            state.history = [
                ...state.history,
                {
                    at: new Date().toISOString(),
                    head,
                    files: changes.length,
                    ...(reason ? { skipped: reason } : {}),
                    ...(auto ? { auto } : {}),
                    ...(logFile ? { log: logFile } : {}),
                },
            ].slice(-50);
            save(root, state);
            if (ref && head) git(root, "update-ref", ref, head);
            return changes;
        },
    };
}

// ─── git 명령 해석 ──────────────────────────────────────────────────────────

// 셸 명령을 따옴표를 존중해 토큰과 연산자(&&, ||, ;, |, 줄바꿈, 괄호, 백틱)로 나눈다.
function lex(cmd) {
    const out = [];
    let cur = "";
    let has = false;
    const push = () => {
        if (has) out.push({ word: cur });
        cur = "";
        has = false;
    };
    for (let i = 0; i < cmd.length; i++) {
        const c = cmd[i];
        if (c === "'") {
            const j = cmd.indexOf("'", i + 1);
            cur += cmd.slice(i + 1, j < 0 ? cmd.length : j);
            has = true;
            i = j < 0 ? cmd.length : j;
        } else if (c === '"') {
            let j = i + 1;
            while (j < cmd.length && cmd[j] !== '"') {
                if (cmd[j] === "\\" && j + 1 < cmd.length) j++;
                cur += cmd[j];
                j++;
            }
            has = true;
            i = j;
        } else if (c === "\\" && i + 1 < cmd.length) {
            cur += cmd[++i];
            has = true;
        } else if (/\s/.test(c) && c !== "\n") {
            push();
        } else if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")" || c === "`") {
            push();
            if ((c === "&" || c === "|") && cmd[i + 1] === c) i++;
            out.push({ op: c });
        } else {
            cur += c;
            has = true;
        }
    }
    push();
    return out;
}

function segments(cmd) {
    const result = [[]];
    for (const token of lex(cmd)) {
        if (token.op) result.push([]);
        else result[result.length - 1].push(token.word);
    }
    return result.filter((words) => words.length > 0);
}

const expandHome = (p) => p.replace(/^~(?=$|\/)/, process.env.HOME ?? "~");

export const realpathOr = (p) => {
    try {
        return realpathSync(p);
    } catch {
        return p;
    }
};

// 값을 하나 받는 commit 옵션 (이 값은 경로가 아니다)
const COMMIT_VALUE_OPTIONS = new Set([
    "-m", "--message", "-F", "--file", "-C", "--reuse-message", "-c", "--reedit-message",
    "--author", "--date", "-t", "--template", "--fixup", "--squash", "--cleanup", "--trailer", "-S", "--gpg-sign",
]);
// 뒤에 오는 명령을 그대로 실행하는 접두 명령. 옵션과 숫자 인자(timeout 10 등)는 건너뛴다.
const PREFIX_COMMANDS = new Set(["env", "command", "builtin", "exec", "nohup", "time", "nice", "sudo", "timeout", "stdbuf"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const GIT_SUBCOMMANDS = new Set([
    "add", "stage", "commit", "push", "status", "diff", "log", "show", "fetch", "pull", "merge", "rebase", "reset",
    "checkout", "switch", "restore", "branch", "tag", "stash", "rev-parse", "config", "remote", "init", "clone",
    "worktree", "cherry-pick", "revert", "rm", "mv", "ls-files", "blame", "grep", "describe", "help",
]);

function stripPrefixes(tokens) {
    const rest = [...tokens];
    for (;;) {
        while (rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) rest.shift(); // VAR=값 접두사
        if (!rest.length || !PREFIX_COMMANDS.has(path.basename(rest[0]))) return rest;
        rest.shift();
        while (rest.length && (rest[0].startsWith("-") || /^\d+[smhd]?$/.test(rest[0]))) rest.shift();
    }
}

function gitAlias(dir, name) {
    try {
        return execFileSync("git", ["config", "--get", `alias.${name}`], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
        return null;
    }
}

// cd를 따라가며 git 호출을 찾고, 커밋에 담길 경로 단서(git add 인자, commit -a, commit 경로)를 모은다.
// sh -c / bash -c / eval의 문자열과 git alias는 펼쳐서 다시 해석한다.
// 해석할 수 없는 형태(xargs git commit 같은)로 commit/push를 부르면 unparsed에 담는다.
export function findGitCalls(cmd, startDir, depth = 0) {
    const calls = [];
    const unparsed = [];
    let staged = { all: false, trackedOnly: false, paths: [] };
    let dir = startDir;
    for (const words of segments(cmd)) {
        const tokens = stripPrefixes(words);
        const head = tokens.length ? path.basename(tokens[0]) : "";
        if (head === "cd") {
            if (tokens[1]) dir = path.resolve(dir, expandHome(tokens[1]));
            continue;
        }
        const shellFlag = SHELLS.has(head) ? tokens.findIndex((token, index) => index > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(token)) : -1;
        if (depth < 3 && (head === "eval" || shellFlag > 0)) {
            const script = head === "eval" ? tokens.slice(1).join(" ") : tokens[shellFlag + 1] ?? "";
            const nested = findGitCalls(script, dir, depth + 1);
            for (const call of nested.calls) calls.push(call);
            unparsed.push(...nested.unparsed);
            continue;
        }
        if (head !== "git") {
            // git이 명령 자리가 아닌 곳에서 commit/push와 함께 실행 인자로 쓰였다 (xargs git commit, find -exec git push)
            const at = tokens.findIndex((token, index) => index > 0 && path.basename(token) === "git");
            if (at > 0 && tokens.slice(at + 1).some((token) => token === "commit" || token === "push")) unparsed.push(tokens.join(" "));
            continue;
        }
        let i = 1;
        let callDir = dir;
        while (i < tokens.length && tokens[i].startsWith("-")) {
            if (tokens[i] === "-C" && tokens[i + 1]) {
                callDir = path.resolve(callDir, expandHome(tokens[i + 1]));
                i += 2;
            } else if (["-c", "--git-dir", "--work-tree", "--namespace"].includes(tokens[i])) {
                i += 2;
            } else {
                i += 1;
            }
        }
        let sub = tokens[i];
        let args = tokens.slice(i + 1);
        if (sub && !GIT_SUBCOMMANDS.has(sub)) {
            const alias = gitAlias(callDir, sub);
            if (alias?.startsWith("!")) {
                if (/\b(commit|push)\b/.test(alias)) unparsed.push(`git ${sub} (alias: ${alias})`);
                continue;
            }
            if (alias) {
                const expanded = alias.split(/\s+/).filter(Boolean);
                sub = expanded[0];
                args = [...expanded.slice(1), ...args];
            }
        }
        if (sub === "add" || sub === "stage") {
            const paths = args.filter((a) => !a.startsWith("-"));
            if (args.some((a) => ["-u", "--update"].includes(a))) {
                staged.all = true;
            } else if (args.some((a) => ["-A", "--all"].includes(a)) || paths.some((p) => p === "." || p === ":/")) {
                staged.all = true;
                staged.trackedOnly = false; // untracked도 담는다
            }
            staged.paths.push(...paths.map((p) => path.relative(callDir, path.resolve(callDir, p))));
        } else if (sub === "commit") {
            const commitPaths = [];
            for (let j = 0; j < args.length; j++) {
                const a = args[j];
                if (a === "--") {
                    commitPaths.push(...args.slice(j + 1));
                    break;
                }
                if (a === "-a" || a === "--all" || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a) && !a.startsWith("--")) {
                    staged.all = true;
                    staged.trackedOnly = true;
                }
                if (COMMIT_VALUE_OPTIONS.has(a) || /^-[a-zA-Z]*[mFCct]$/.test(a)) {
                    j++;
                    continue;
                }
                if (!a.startsWith("-")) commitPaths.push(a);
            }
            calls.push({ sub, args, dir: callDir, staged: { ...staged, paths: [...staged.paths, ...commitPaths.map((p) => path.relative(callDir, path.resolve(callDir, p)))] } });
            staged = { all: false, trackedOnly: false, paths: [] }; // 커밋이 담아 간 단서는 다음 커밋으로 넘기지 않는다
        } else if (sub === "push") {
            calls.push({ sub, args, dir: callDir });
        }
    }
    return { calls, unparsed };
}

// 이번 커밋에 실제로 담길 수 있는 변경만 고른다: 작업 트리는 add/commit 인자가 가리키는 것만,
// index는 그 작업 트리 내용으로 덮이지 않는 것만 (git add로 덮일 옛 staged 내용은 커밋에 담기지 않는다).
// root는 git이 돌려준 실제 경로이므로, callDir도 실제 경로로 바꿔야 상대 경로가 맞는다 (/var → /private/var 같은 심볼릭 링크).
export function commitCandidates(changes, staged, callDir, root) {
    const prefix = path.relative(root, realpathOr(callDir));
    const targets = staged.paths.map((p) => path.normalize(path.join(prefix, p)));
    const matches = (file) => targets.some((t) => t === "." || file === t || file.startsWith(`${t}/`));
    const included = (change) =>
        (staged.all && !(staged.trackedOnly && change.untracked)) || matches(change.path); // commit -a라도 git add로 직접 지정한 새 파일은 담긴다
    const overwritten = new Set(changes.filter((change) => change.where !== "staged" && included(change)).map((change) => change.path));
    return changes.filter((change) => (change.where === "staged" ? !overwritten.has(change.path) : included(change)));
}

export function inProgressOperation(root) {
    for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
        if (existsSync(path.resolve(root, git(root, "rev-parse", "--git-path", name)))) return name;
    }
    return null;
}

export function isNonContentPush(args) {
    return args.some((arg) => arg === "--delete" || arg === "-d" || arg === "--tags" || /^:/.test(arg));
}

// ─── PreToolUse 게이트 ──────────────────────────────────────────────────────

const looksLikeCommitOrPush = (text) => /\bgit\b/.test(text) && /\b(commit|push)\b/.test(text);

function writeDecision(decision, reason) {
    process.stdout.write(
        `${JSON.stringify({
            hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason },
        })}\n`,
    );
    process.exit(0);
}

// PreToolUse(Bash) 훅 본체. 판단할 수 없을 때 조용히 통과시키지 않는다:
// - 훅 입력을 해석하지 못했는데 commit/push로 보이면 막는다
// - 변경을 확인하다 git이 실패하면 사용자에게 확인을 받는다
// - 해석할 수 없는 형태로 commit/push를 부르면 사용자에게 확인을 받는다
// onBlocked(call, blocked, what, scope)는 막을 때의 결정을 돌려준다: { decision, reason }
export function runGitGuard({ name, store, gateDisabled, onBlocked }) {
    let raw = "";
    let input;
    try {
        raw = readFileSync(0, "utf8");
        input = JSON.parse(raw);
    } catch {
        if (looksLikeCommitOrPush(raw)) {
            writeDecision("deny", `${name} 게이트가 훅 입력을 해석하지 못해 커밋·푸시인지 확인할 수 없습니다. 명령을 단순한 형태(git add … && git commit …)로 다시 실행하세요.`);
        }
        process.exit(0);
    }
    const command = String(input?.tool_input?.command ?? "");
    // alias(git ci 등)는 commit이라는 단어 없이도 커밋하므로 git만 보이면 해석한다
    if (!/\bgit\b/.test(command)) process.exit(0);
    if (gateDisabled("commit") && gateDisabled("push")) process.exit(0);

    const { calls, unparsed } = findGitCalls(command, input.cwd ?? process.cwd());
    for (const call of calls) {
        if (gateDisabled(call.sub)) continue;
        const root = repoRoot(call.dir);
        if (!root) continue;

        let blocked;
        try {
            if (call.sub === "commit") {
                if (inProgressOperation(root)) continue; // merge·cherry-pick·revert·rebase 중의 커밋은 다른 곳에서 온 내용이다
                blocked = store.unchecked(root, commitCandidates(pendingChanges(root), call.staged, call.dir, root));
            } else {
                if (isNonContentPush(call.args)) continue;
                blocked = store.unchecked(root, unpushedChanges(root));
            }
        } catch (error) {
            writeDecision(
                "ask",
                `${name} 게이트가 ${call.sub === "commit" ? "커밋" : "푸시"}할 변경을 확인하지 못했습니다 (${String(error?.message ?? error).split("\n")[0]}). 검사 없이 진행할까요?`,
            );
        }
        if (blocked.length === 0) continue;

        const what = call.sub === "commit" ? "커밋" : "푸시";
        const scope = call.sub === "commit" ? "커밋되지 않은 소스 변경" : "원격에 없는 커밋의 소스 변경";
        const { decision, reason } = onBlocked(call, blocked, what, scope);
        writeDecision(decision, reason);
    }

    if (unparsed.length > 0 && !(gateDisabled("commit") && gateDisabled("push"))) {
        const root = repoRoot(input.cwd ?? process.cwd());
        if (!root || !backstopInstalled(root)) {
            writeDecision(
                "ask",
                `${name} 게이트가 해석할 수 없는 형태로 커밋·푸시를 실행합니다 (${unparsed[0]}). 검사 없이 진행할까요? 단순한 git 명령으로 바꿔 실행하면 게이트가 검사합니다.`,
            );
        }
    }
    process.exit(0);
}

// ─── 위험도 ─────────────────────────────────────────────────────────────────

// 경로만으로 민감하다고 보는 파일: 인증·권한·서버 진입점·설정·의존성·배포
const SENSITIVE_PATH =
    /(^|\/)(auth|login|logout|signin|signup|session|token|oauth|jwt|crypto|secur|permission|acl|rbac|role|admin|middleware|proxy|api|routes?|server|handlers?|controllers?|webhooks?|payment|billing|checkout)([./_-]|$)/i;
const SENSITIVE_FILES =
    /(^|\/)(\.env[^/]*|package\.json|requirements[^/]*\.txt|pyproject\.toml|setup\.py|go\.mod|Cargo\.toml|Gemfile|composer\.json|build\.gradle(\.kts)?|Podfile|Dockerfile|docker-compose[^/]*\.ya?ml|AndroidManifest\.xml|Info\.plist|app\.json|app\.config\.[jt]s|(next|vite|nuxt)\.config\.[cm]?[jt]s|vercel\.json|netlify\.toml|firebase\.json|[^/]*\.rules|nginx[^/]*\.conf|\.npmrc|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|uv\.lock|Pipfile(\.lock)?|go\.sum|Cargo\.lock|Gemfile\.lock|composer\.lock)$|(^|\/)\.github\/workflows\//i;
// 추가된 줄에 나오면 민감하다고 보는 패턴: 인증·시크릿·위험한 싱크·네트워크·저장소
const SENSITIVE_CONTENT = new RegExp(
    [
        String.raw`passw(or)?d|secret|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|bearer|authorization|credential`,
        String.raw`\bjwt\b|\bsession\b|\bcookie|csrf|cors|oauth|signIn|signOut|\blogin\b`,
        String.raw`\beval\s*\(|new Function\s*\(|child_process|\bexec(Sync|File)?\s*\(|\bspawn(Sync)?\s*\(|subprocess|os\.system|shell\s*=\s*True`,
        String.raw`innerHTML|outerHTML|dangerouslySetInnerHTML|v-html|document\.write|bypassSecurityTrust`,
        String.raw`\b(SELECT|INSERT|UPDATE|DELETE)\b.+\b(FROM|INTO|SET|WHERE)\b|\.raw\s*\(|\$queryRaw|\bquery\s*\(\s*[\x60'"]`,
        String.raw`pickle\.loads?|yaml\.load\s*\(|deserializ|readFile\w*\s*\(.*req\.|path\.join\s*\(.*req\.`,
        String.raw`localStorage|sessionStorage|AsyncStorage|SecureStore|Keychain|MMKV`,
        String.raw`http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)|rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|verify\s*=\s*False`,
        String.raw`\bredirect\s*\(|window\.location\s*=|Linking\.|deep ?link|postMessage|process\.env\.`,
        String.raw`\bpermission|\bisAdmin\b|\brole\b|\bowner(Id)?\b`,
    ].join("|"),
    "i",
);

const RISK_DEFAULTS = { trivialLines: 20, trivialFiles: 3 };

export const RISK_PLANS = {
    // 테스트: run(기존 테스트만 실행) | write(변경 파일 테스트 작성)
    // 보안: scan(자동 스캔 후 깨끗하면 자동 기록) | full(감사 에이전트)
    // 리뷰: skip(자동 생략 기록) | review(codex 기본 리뷰) | adversarial-review(설계까지 의심하는 리뷰)
    none: { tests: "run", audit: "none", review: "none" },
    trivial: { tests: "run", audit: "scan", review: "skip" },
    standard: { tests: "write", audit: "scan", review: "review" },
    sensitive: { tests: "write", audit: "full", review: "adversarial-review" },
};

export function riskMode() {
    const mode = (process.env.BATON_MODE ?? "auto").toLowerCase();
    return ["fast", "standard", "strict", "auto"].includes(mode) ? mode : "auto";
}

// 모드가 위험도를 바꾼다. fast도 민감한 변경은 낮추지 않는다.
function effectiveLevel(level, mode) {
    if (level === "none") return "none";
    if (mode === "strict") return "sensitive";
    if (mode === "fast") return level === "sensitive" ? "sensitive" : "trivial";
    if (mode === "standard") return level === "trivial" ? "standard" : level;
    return level;
}

// 지금 작업 트리 전체(추적 + untracked, .gitignore 제외)를 tree 객체로 만든다. 저장소 index는 건드리지 않는다.
export function snapshotTree(root) {
    const scratch = mkdtempSync(path.join(tmpdir(), "baton-index-"));
    const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
    try {
        if (hasHead(root)) gitWith(root, ["read-tree", "HEAD"], { env });
        else gitWith(root, ["read-tree", "--empty"], { env });
        gitWith(root, ["add", "-A", "--", "."], { env });
        return gitWith(root, ["write-tree"], { env });
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

// 이번에 올라갈 변경 전체(원격에 없는 커밋 + 미커밋 변경)의 시작점
export function shipBase(root) {
    return unpushedBase(root) ?? (hasHead(root) ? git(root, "rev-parse", "HEAD") : EMPTY_TREE);
}

// 스냅샷(tree)이 base에서 바꾼 소스 파일과 그 스냅샷 시점 내용. 리뷰 델타·감사·통과 기록이 모두 이 목록을 본다.
export function snapshotChanges(root, { tree = snapshotTree(root), base = shipBase(root) } = {}) {
    const changes = [];
    for (const entry of parseNameStatus(git(root, "diff", "--name-status", "--no-renames", base, tree))) {
        if (!isSource(entry.path)) continue;
        const hash = entry.deleted ? DELETED : git(root, "rev-parse", `${tree}:${entry.path}`);
        changes.push({ path: entry.path, hash, where: "snapshot" });
    }
    return changes;
}

function addedLines(root, base, tree, paths) {
    if (paths.length === 0) return [];
    const diff = git(root, "diff", "--no-color", "--no-ext-diff", "-U0", base, tree, "--", ...paths);
    return lines(diff).filter((line) => line.startsWith("+") && !line.startsWith("+++"));
}

// 이번 변경의 위험도를 판정한다. 결과는 { level, mode, effective, plan, reasons, stats }.
export function classifyRisk(root, { tree = snapshotTree(root), base = shipBase(root), limits = RISK_DEFAULTS } = {}) {
    const mode = riskMode();
    const reasons = [];
    const numstat = lines(git(root, "diff", "--numstat", "--no-renames", base, tree)).map((line) => {
        const [added, removed, file] = line.split("\t");
        return { file, added: Number(added) || 0, removed: Number(removed) || 0, binary: added === "-" };
    });
    const status = new Map(
        lines(git(root, "diff", "--name-status", "--no-renames", base, tree)).map((line) => {
            const [code, file] = line.split("\t");
            return [file, code];
        }),
    );

    const configLike = numstat.filter((entry) => SENSITIVE_FILES.test(entry.file));
    const source = numstat.filter((entry) => isSource(entry.file));
    const stats = {
        files: numstat.length,
        sourceFiles: source.length,
        sourceLines: source.reduce((sum, entry) => sum + entry.added + entry.removed, 0),
        newSourceFiles: source.filter((entry) => status.get(entry.file) === "A").length,
    };

    for (const entry of configLike) reasons.push(`설정·의존성·배포 파일 변경: ${entry.file}`);
    for (const entry of source) {
        if (SENSITIVE_PATH.test(entry.file) && !configLike.includes(entry)) reasons.push(`민감한 경로: ${entry.file}`);
    }
    const hits = addedLines(root, base, tree, source.filter((entry) => !entry.binary).map((entry) => entry.file))
        .map((line) => line.slice(1))
        .filter((line) => SENSITIVE_CONTENT.test(line));
    if (hits.length > 0) reasons.push(`민감한 코드 ${hits.length}줄 (예: ${hits[0].trim().slice(0, 80)})`);

    let level;
    if (source.length === 0 && configLike.length === 0) level = "none";
    else if (reasons.length > 0) level = "sensitive";
    else if (stats.sourceLines <= limits.trivialLines && stats.sourceFiles <= limits.trivialFiles) level = "trivial";
    else level = "standard";

    const effective = effectiveLevel(level, mode);
    return { level, mode, effective, plan: RISK_PLANS[effective], reasons, stats, base, tree };
}

// ─── 시크릿 자동 스캔 ───────────────────────────────────────────────────────

const SECRET_FILE =
    /(^|\/)(\.env($|\.)|.*\.(pem|key|p8|p12|pfx|jks|keystore|mobileprovision)$|id_(rsa|ed25519|ecdsa)$|credentials\.json$|service-account.*\.json$|google-services\.json$|GoogleService-Info\.plist$|\.npmrc$|\.pypirc$|\.netrc$)/i;
const SECRET_TEMPLATE = /\.(example|sample|template)$/i;
const SECRET_VALUE = [
    /AKIA[0-9A-Z]{16}/,
    /sk_live_[0-9A-Za-z]{8,}/,
    /sk-(proj-)?[A-Za-z0-9_-]{20,}/,
    /gh[pousr]_[A-Za-z0-9]{36}/,
    /xox[baprs]-[A-Za-z0-9-]{10,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /AIza[0-9A-Za-z_-]{35}/,
    /(api[_-]?key|secret|password|passwd|token|client[_-]?secret|access[_-]?key)["']?\s*[:=]\s*["'][^"'\s$<{]{8,}["']/i,
];

// 감사 A절(저장소에 들어가면 안 되는 것)을 자동으로 확인한다. 하나라도 걸리면 자동 기록하지 않는다.
export function scanSecrets(root, { tree = snapshotTree(root), base = shipBase(root) } = {}) {
    const findings = [];
    for (const file of lines(git(root, "ls-tree", "-r", "--name-only", tree))) {
        if (SECRET_FILE.test(file) && !SECRET_TEMPLATE.test(file)) findings.push(`추적 중인 시크릿 파일: ${file}`);
    }
    for (const line of addedLines(root, base, tree, ["."])) {
        if (SECRET_VALUE.some((pattern) => pattern.test(line))) {
            findings.push(`시크릿으로 보이는 값: ${line.slice(1).trim().slice(0, 12)}••••`);
        }
    }
    return findings;
}

// ─── 리뷰 델타 ──────────────────────────────────────────────────────────────

const SYNTHETIC_IDENTITY = {
    GIT_AUTHOR_NAME: "baton",
    GIT_AUTHOR_EMAIL: "baton@localhost",
    GIT_COMMITTER_NAME: "baton",
    GIT_COMMITTER_EMAIL: "baton@localhost",
};

function treeEntry(root, tree, file) {
    const line = tryGit(root, "ls-tree", tree, "--", file);
    if (!line) return null;
    const [meta, ] = line.split("\t");
    const [mode, , hash] = meta.split(" ");
    return { mode, hash };
}

// 아직 통과하지 않은 내용만 diff로 보이는 두 커밋을 만든다.
// - reviewed(R): 지금 작업 트리에서, 통과하지 않은 소스 파일만 마지막 통과 내용(없으면 base 내용)으로 되돌린 상태
// - current(C): 지금 작업 트리 그대로. 부모가 R이라서 `R..C`가 곧 리뷰할 델타다.
// 이미 통과한 파일과 문서·에셋은 델타에 나오지 않는다.
export function buildDelta(root, store, { tree = snapshotTree(root), base = shipBase(root) } = {}) {
    const { files: passed } = store.load(root);
    const changed = lines(git(root, "diff", "--name-only", "--no-renames", base, tree)).filter(isSource);
    const overrides = [];
    const reviewFiles = [];
    for (const file of changed) {
        const current = treeEntry(root, tree, file);
        const change = { path: file, hash: current?.hash ?? DELETED, where: "unpushed" };
        if (store.isPassed(root, change, passed)) continue;
        reviewFiles.push(file);
        const previous = [...(passed[file] ?? [])].reverse().find((hash) => hash === DELETED || tryGit(root, "cat-file", "-e", hash) !== null);
        const fallback = base === EMPTY_TREE ? null : treeEntry(root, base, file);
        const target = previous === undefined ? fallback : previous === DELETED ? null : { mode: current?.mode ?? fallback?.mode ?? "100644", hash: previous };
        overrides.push(target ? `${target.mode} ${target.hash}\t${file}` : `0 ${"0".repeat(40)}\t${file}`);
    }
    if (reviewFiles.length === 0) return { empty: true, files: [] };

    const scratch = mkdtempSync(path.join(tmpdir(), "baton-delta-index-"));
    const env = { GIT_INDEX_FILE: path.join(scratch, "index"), ...SYNTHETIC_IDENTITY };
    let reviewedTree;
    try {
        gitWith(root, ["read-tree", tree], { env });
        gitWith(root, ["update-index", "--index-info"], { env, input: `${overrides.join("\n")}\n` });
        reviewedTree = gitWith(root, ["write-tree"], { env });
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
    const parent = hasHead(root) ? ["-p", "HEAD"] : [];
    const reviewed = gitWith(root, ["commit-tree", reviewedTree, ...parent, "-m", "baton: 이미 리뷰한 내용"], { env: SYNTHETIC_IDENTITY });
    const current = gitWith(root, ["commit-tree", tree, "-p", reviewed, "-m", "baton: 아직 리뷰하지 않은 변경"], { env: SYNTHETIC_IDENTITY });
    const stat = git(root, "diff", "--shortstat", reviewed, current);
    return { empty: false, files: reviewFiles, reviewed, current, stat };
}

// ─── git 훅 백스톱 ──────────────────────────────────────────────────────────

const BACKSTOP_MARK = "# baton-gate-backstop";
const BACKSTOP_HOOKS = ["pre-commit", "pre-push"];

function backstopScript(hook) {
    return `#!/bin/sh
${BACKSTOP_MARK} (review·security 플러그인이 설치함)
# Claude Code가 실행한 커밋·푸시만 검사한다. 사람이 터미널에서 하는 커밋은 막지 않는다.
# PreToolUse 훅이 해석하지 못한 형태(스크립트, alias 등)로 실행된 커밋·푸시를 잡는 2차 방어선이다.
[ "$CLAUDECODE" = "1" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0
roots="\${BATON_PLUGIN_ROOTS:-}"
cache="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache"
${hook === "pre-push" ? 'input=$(cat)\n' : ""}for plugin in review security; do
  script=""
  if [ -n "$roots" ]; then
    script=$(printf '%s\\n' "$roots" | tr ':' '\\n' | while read -r dir; do [ -f "$dir/$plugin/hooks/git-backstop.mjs" ] && echo "$dir/$plugin/hooks/git-backstop.mjs"; done | head -1)
  else
    script=$(ls -d "$cache"/*/"$plugin"/*/hooks/git-backstop.mjs 2>/dev/null | sort -V | tail -1)
  fi
  [ -n "$script" ] || continue
  ${hook === "pre-push" ? `printf '%s\\n' "$input" | node "$script" ${hook} "$@" || exit 1` : `node "$script" ${hook} "$@" || exit 1`}
done
exit 0
`;
}

function hooksDir(root) {
    return path.resolve(root, git(root, "rev-parse", "--git-path", "hooks"));
}

export function backstopInstalled(root) {
    try {
        return BACKSTOP_HOOKS.every((hook) => readFileSync(path.join(hooksDir(root), hook), "utf8").includes(BACKSTOP_MARK));
    } catch {
        return false;
    }
}

// 기존 훅이나 훅 관리 도구(core.hooksPath: husky 등)가 있으면 덮어쓰지 않는다. 결과를 한 줄로 돌려준다.
export function installBackstop(root) {
    if (process.env.BATON_BACKSTOP === "0") return null;
    if (tryGit(root, "config", "--get", "core.hooksPath")) return "core.hooksPath를 쓰는 저장소라 git 훅 백스톱을 설치하지 않았습니다.";
    const dir = hooksDir(root);
    const installed = [];
    const skipped = [];
    for (const hook of BACKSTOP_HOOKS) {
        const file = path.join(dir, hook);
        const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
        if (existing !== null && !existing.includes(BACKSTOP_MARK)) {
            skipped.push(hook);
            continue;
        }
        const script = backstopScript(hook);
        if (existing === script) continue;
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, script, { mode: 0o755 });
        installed.push(hook);
    }
    const parts = [];
    if (installed.length) parts.push(`git 훅 백스톱을 설치했습니다 (${installed.join(", ")}). Claude Code가 실행한 커밋·푸시만 검사합니다.`);
    if (skipped.length) parts.push(`기존 ${skipped.join(", ")} 훅이 있어 백스톱을 설치하지 않았습니다.`);
    return parts.join(" ") || null;
}

// git 훅에서 실행된다. 막으면 1, 통과하면 0을 돌려준다. 확인하지 못하면 경고만 하고 통과시킨다 (1차 방어선은 PreToolUse 훅이다).
export function runBackstop({ name, store, gateDisabled, howToFix, hook }) {
    if (process.env.CLAUDECODE !== "1") return 0;
    const kind = hook === "pre-commit" ? "commit" : "push";
    if (gateDisabled(kind)) return 0;
    const root = repoRoot(process.cwd());
    if (!root) return 0;
    let blocked = [];
    try {
        if (hook === "pre-commit") {
            if (inProgressOperation(root)) return 0;
            // git이 넘긴 GIT_INDEX_FILE을 그대로 쓰므로 commit -a, commit <경로>도 실제로 담길 내용을 본다
            blocked = store.unchecked(root, pendingChanges(root).filter((change) => change.where === "staged"));
        } else {
            const zero = /^0+$/;
            for (const line of lines(readFileSync(0, "utf8"))) {
                const [, localSha, , remoteSha] = line.split(" ");
                if (!localSha || zero.test(localSha)) continue;
                let base = remoteSha && !zero.test(remoteSha) && tryGit(root, "cat-file", "-e", `${remoteSha}^{commit}`) !== null ? remoteSha : null;
                if (!base) {
                    const commits = lines(git(root, "rev-list", "--reverse", localSha, "--not", "--remotes"));
                    if (commits.length === 0) continue;
                    base = tryGit(root, "rev-parse", "-q", "--verify", `${commits[0]}^`) ?? EMPTY_TREE;
                }
                blocked.push(...store.unchecked(root, rangeChanges(root, base, localSha)));
            }
        }
    } catch (error) {
        process.stderr.write(`[${name}] git 훅 백스톱이 변경을 확인하지 못해 통과시킵니다: ${String(error?.message ?? error).split("\n")[0]}\n`);
        return 0;
    }
    if (blocked.length === 0) return 0;
    process.stderr.write(
        `[${name}] ${name}를 통과하지 않은 소스 변경이 있어 ${kind === "commit" ? "커밋" : "푸시"}할 수 없습니다: ${describe(blocked)}.\n${howToFix}\n` +
            "(사람이 직접 실행한 커밋이면 --no-verify로 건너뛸 수 있습니다.)\n",
    );
    return 1;
}

// ─── ship 단계 기록의 재사용 판단 ───────────────────────────────────────────
// git:ship(stage.mjs)과 progress(facts.mjs)가 같은 기준으로 "이 통과 기록을 지금 그대로 써도 되는가"를 판단한다.
// 통과는 작업 트리 지문(tree)과 실행 환경에 묶인다. 환경 변수는 값 원문 대신 해시 앞 12자만 남긴다.

// 같은 파일이어도 결과를 바꿀 수 있는 환경 변수
export const STAGE_ENV_NAMES = ["NODE_ENV", "CI", "TZ", "NODE_OPTIONS", "BABEL_ENV", "TS_NODE_PROJECT"];
// 의존성을 설치하면 바뀌는 메타 파일 (node_modules는 .gitignore라 tree 지문에 안 잡힌다)
const INSTALL_STATE_FILES = ["node_modules/.package-lock.json", "node_modules/.modules.yaml", "node_modules/.yarn-state.yml", "node_modules/.yarn-integrity", "node_modules/.bun-tag"];
const PACKAGE_MANAGERS = { npm: "npm", npx: "npm", pnpm: "pnpm", pnpx: "pnpm", yarn: "yarn", bun: "bun", bunx: "bun", deno: "deno" };
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const digest = (text) => createHash("sha256").update(text).digest("hex").slice(0, 12);

// 셸 단어 하나를 읽는다: 작은따옴표, 큰따옴표(안의 \" \\ \$ \` 이스케이프), 따옴표 밖 백슬래시를 셸처럼 해석한다.
// 값을 확정할 수 없는 것(닫히지 않은 따옴표, $변수·$(…)·백틱 치환)은 null로 돌려 해석 실패로 본다.
function readWord(cmd, start) {
    let i = start;
    let value = "";
    while (i < cmd.length && !/\s/.test(cmd[i])) {
        const ch = cmd[i];
        if (ch === "'") {
            const close = cmd.indexOf("'", i + 1);
            if (close < 0) return null;
            value += cmd.slice(i + 1, close);
            i = close + 1;
        } else if (ch === '"') {
            i++;
            for (;;) {
                if (i >= cmd.length) return null;
                if (cmd[i] === '"') break;
                if (cmd[i] === "$" || cmd[i] === "`") return null;
                if (cmd[i] === "\\" && i + 1 < cmd.length && '"\\$`'.includes(cmd[i + 1])) i++;
                value += cmd[i++];
            }
            i++;
        } else if (ch === "\\") {
            if (i + 1 >= cmd.length) return null;
            value += cmd[i + 1];
            i += 2;
        } else if (ch === "$" || ch === "`") {
            return null;
        } else if (";&|<>()".includes(ch)) {
            break;
        } else {
            value += ch;
            i++;
        }
    }
    return { value, end: i };
}

// 셸에 다시 넘겨 해석시키는 실행 파일. 그 인자 안의 대입은 따옴표 속 문자열이라 여기서 가릴 수 없다.
const NESTED_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "eval", "source", "."]);
// 인자의 대입이 뒤따르는 명령의 환경이 되는 내장 명령 (`export NODE_ENV=test && npm test`)
const EXPORTERS = new Set(["export", "declare", "typeset", "readonly", "set"]);

// 명령 전체를 셸 단어·연산자로 나눈다. 값을 확정할 수 없으면 null.
function tokenize(cmd) {
    const tokens = [];
    let i = 0;
    while (i < cmd.length) {
        const ch = cmd[i];
        if (ch === "\n") {
            tokens.push({ type: "op", value: ";" });
            i++;
        } else if (/\s/.test(ch)) {
            i++;
        } else if (ch === "#" && (i === 0 || /\s/.test(cmd[i - 1]))) {
            return null; // 주석 뒤는 실행되지 않지만 값이 남을 수 있다
        } else if (ch === "<" || ch === ">" || (ch === "&" && cmd[i + 1] === ">")) {
            let j = i + 1;
            while (j < cmd.length && "<>&|".includes(cmd[j])) j++;
            const op = cmd.slice(i, j);
            if (op.startsWith("<<")) return null; // here-doc·here-string 본문은 해석하지 않는다
            const fd = op.endsWith("&") && /[0-9-]/.test(cmd[j] ?? "");
            if (fd) j++;
            tokens.push({ type: "redir", target: !fd });
            i = j;
        } else if (";&|()".includes(ch)) {
            const two = cmd.slice(i, i + 2);
            const op = ["&&", "||", ";;", "|&"].includes(two) ? two : ch;
            tokens.push({ type: "op", value: op });
            i += op.length;
        } else {
            const word = readWord(cmd, i);
            if (!word || word.end === i) return null;
            tokens.push({ type: "word", value: word.value, start: i, end: word.end, raw: cmd.slice(i, word.end) });
            i = word.end;
        }
    }
    return tokens;
}

// 단어가 `이름=값` 꼴인지. 이름 부분은 따옴표 없이 그대로 적혀 있어야 셸이 대입으로 본다.
function assignmentOf(word) {
    const eq = word.raw.indexOf("=");
    if (eq <= 0 || !NAME.test(word.raw.slice(0, eq))) return null;
    const name = word.raw.slice(0, eq);
    return { name, value: word.value.slice(name.length + 1) };
}

const FAILED = Object.freeze({ parsed: false, inline: {}, masks: [], program: null, programs: [], commands: [] });

// 명령 전체(`a && B=x b | c; env -u CI D=y d`)를 읽어 각 단순 명령의 인라인 환경 변수와 실행 파일을 찾는다.
// - 대입은 단순 명령의 맨 앞(그리고 env 뒤)에 있을 때 환경 변수다. 인자 자리의 `이름=값`도 값이 새지 않게 가린다.
// - 값을 확정할 수 없는 형태($변수, $(…), 백틱, 닫히지 않은 따옴표, here-doc, 주석, 알 수 없는 env 옵션,
//   셸에 문자열을 다시 넘기는 sh -c·eval)는 parsed: false다. 그때는 인라인 변수도 실행 파일도 믿지 않고 원문도 남기지 않는다.
export function parseCommand(cmd = "") {
    const tokens = tokenize(cmd);
    if (!tokens) return FAILED;
    const inline = {};
    const masks = []; // 가릴 구간 [시작, 끝, 이름, 값]
    const programs = [];
    let atStart = true; // 단순 명령의 맨 앞인가
    let inEnv = false; // env 옵션을 읽는 중인가
    let exporting = false; // export 등의 인자를 읽는 중인가
    const commands = []; // 단순 명령마다 { program, own: 그 명령 맨 앞에서 대입한 이름들 }
    let current = { program: null, own: new Set() };
    const endCommand = () => {
        if (current.program) commands.push(current);
        current = { program: null, own: new Set() };
    };
    for (let k = 0; k < tokens.length; k++) {
        const token = tokens[k];
        if (token.type === "op") {
            endCommand();
            atStart = true;
            inEnv = false;
            exporting = false;
            continue;
        }
        if (token.type === "redir") {
            if (token.target) {
                if (tokens[k + 1]?.type !== "word") return FAILED;
                k++; // 리다이렉트 대상 파일
            }
            continue;
        }
        const assignment = assignmentOf(token);
        if (assignment) {
            masks.push([token.start, token.end, assignment.name, assignment.value]);
            if (atStart || exporting) inline[assignment.name] = assignment.value;
            if (atStart) current.own.add(assignment.name);
            inEnv = false;
            continue;
        }
        if (inEnv && token.value.startsWith("-")) {
            if (token.value === "-u" || token.value === "--unset") {
                if (tokens[k + 1]?.type !== "word") return FAILED;
                k++;
            } else if (!/^(-i|--ignore-environment|-|--|-u\S+|--unset=\S+)$/.test(token.value)) {
                return FAILED; // -S(문자열을 다시 쪼갬)·-C 등은 해석하지 않는다
            }
            continue;
        }
        if (atStart) {
            const name = path.basename(token.value);
            if (NESTED_SHELLS.has(name)) return FAILED;
            if (name === "env") {
                inEnv = true;
                continue;
            }
            programs.push(name);
            current.program = name;
            exporting = EXPORTERS.has(name);
            atStart = false;
            inEnv = false;
        }
    }
    endCommand();
    return { parsed: true, inline, masks, program: programs[0] ?? null, programs, commands };
}

// 기록에 남길 명령: `이름=값` 꼴의 값은 어디에 있든 지문으로 바꿔 원문을 저장하지 않는다.
// 값을 확정할 수 없는 명령은 원문을 남기지 않는다(값 일부가 새어 나갈 수 있어서).
export function maskCommand(cmd) {
    if (!cmd) return cmd;
    const { parsed, masks } = parseCommand(cmd);
    if (!parsed) return `(해석할 수 없는 명령이라 원문을 남기지 않음 · #${digest(cmd)})`;
    let masked = cmd;
    for (const [start, end, name, value] of [...masks].reverse()) {
        masked = `${masked.slice(0, start)}${name}=#${digest(value)}${masked.slice(end)}`;
    }
    return masked;
}

function packageManagerVersion(name, root) {
    if (!name) return null;
    try {
        return `${name} ${execFileSync(name, ["--version"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }).trim()}`;
    } catch {
        return `${name} (버전 확인 실패)`;
    }
}

function declaredPackageManager(root) {
    try {
        return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).packageManager ?? null;
    } catch {
        return null;
    }
}

// 검사를 실행한 환경. cmd를 주면 인라인 환경 변수와 실제 패키지 매니저 버전까지 담는다.
export function stageEnvironment(root, { cmd = null, names = [], cwd = process.cwd(), env = process.env } = {}) {
    const { parsed, inline, programs, commands } = parseCommand(cmd ?? "");
    // 셸 환경 비교에서 빼도 되는 변수는 모든 단순 명령이 각자 맨 앞에서 대입한 것뿐이다.
    // `NODE_ENV=test a && b`의 b는 셸의 NODE_ENV를 쓰고, export·set은 앞 명령이 실패하면 적용되지 않을 수 있어 빼지 않는다.
    const covered = commands.length ? [...commands[0].own].filter((name) => commands.every((command) => command.own.has(name))) : [];
    const tracked = [...new Set([...STAGE_ENV_NAMES, ...names])].filter((name) => !covered.includes(name)).sort();
    const installState = INSTALL_STATE_FILES.filter((file) => existsSync(path.join(root, file))).map((file) => `${file}:${digest(readFileSync(path.join(root, file)))}`);
    return {
        runtime: `node ${process.version} ${process.platform}-${process.arch}`,
        packageManager: declaredPackageManager(root),
        packageManagerVersion: packageManagerVersion(PACKAGE_MANAGERS[programs.find((name) => PACKAGE_MANAGERS[name])], root),
        install: installState.length ? digest(installState.join("\n")) : null,
        cwd: path.relative(root, cwd) || ".",
        vars: Object.fromEntries(tracked.map((name) => [name, env[name] === undefined ? null : digest(env[name])])),
        inline: Object.fromEntries(Object.entries(inline).map(([name, value]) => [name, digest(value)])),
        ...(cmd && !parsed ? { commandParsed: false } : {}),
    };
}

const ENV_LABELS = { runtime: "런타임", packageManager: "packageManager", packageManagerVersion: "패키지 매니저 버전", install: "의존성 설치 상태", cwd: "작업 디렉터리" };

// 기록된 환경과 지금 환경의 차이. 인라인 환경 변수는 명령의 일부라 다시 비교하지 않는다(같은 명령이면 같은 값).
export function stageEnvironmentDiff(root, recorded, options = {}) {
    if (!recorded) return ["실행 환경 기록 없음(이전 버전 기록)"];
    const pm = recorded.packageManagerVersion?.split(" ")[0];
    const current = stageEnvironment(root, { ...options, cmd: pm ? pm : null, names: Object.keys(recorded.vars ?? {}) });
    const diffs = Object.keys(ENV_LABELS)
        .filter((key) => (recorded[key] ?? null) !== (current[key] ?? null))
        .map((key) => `${ENV_LABELS[key]} ${recorded[key] ?? "없음"} → ${current[key] ?? "없음"}`);
    for (const [name, value] of Object.entries(recorded.vars ?? {})) {
        if (current.vars[name] !== value) diffs.push(`환경 변수 ${name} 변경`);
    }
    return diffs;
}

// 통과 기록 하나를 지금 그대로 쓸 수 있는가.
//   passed  지금 내용·환경으로 전체 범위를 통과함
//   partial 일부 범위만 통과함 (관련 테스트만 통과)
//   stale   내용은 같지만 환경이 다름 (현재 환경에서 재검증 필요)
//   unstable 검사 도중 작업 트리나 환경이 바뀌었거나, 명령의 환경을 확정할 수 없음 (검사가 본 내용을 특정할 수 없음)
//   changed 기록 뒤에 파일이 바뀜
//   failed  실패 기록
export function stageReuse(root, entry, { fingerprint, tree, ...options } = {}) {
    if (!entry) return { status: "todo" };
    if (fingerprint && tree && fingerprint !== tree) return { ...entry, status: "changed", recorded: entry.status };
    if (entry.status !== "passed") return entry;
    if (entry.scope === "partial") return { ...entry, status: "partial" };
    if (entry.unstable) return { ...entry, status: "unstable", reason: entry.unstable };
    if (entry.env?.commandParsed === false) return { ...entry, status: "unstable", reason: "명령 앞의 환경 변수를 해석할 수 없어 실행 환경을 확정할 수 없음" };
    const diffs = stageEnvironmentDiff(root, entry.env, options);
    return diffs.length ? { ...entry, status: "stale", reason: diffs.join(", ") } : entry;
}
