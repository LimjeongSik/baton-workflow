// 보안 감사 상태: "어떤 파일의 어떤 내용이 보안 감사를 통과했는가"를 blob 해시로 기록하고 대조한다.
//
// 기록은 <git-dir>/security-audit/passed.json에 둔다. 저장소에 커밋되지 않고, worktree마다 따로 관리된다.
// 감사 뒤에 파일이 한 글자라도 바뀌면 해시가 달라져 다시 감사 대상이 된다 (리뷰 반영으로 바뀐 파일 포함).
// 감사한 내용은 여러 커밋으로 나눠 담아도 그대로 인정된다.
// review 플러그인의 lib/review-state.mjs와 같은 구조다. 플러그인은 따로 설치되므로 코드를 공유하지 않는다.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const DELETED = "-";
const MAX_HASHES_PER_FILE = 20;

// 감사 대상이 아닌 파일: 문서, 에셋, lockfile, 도구 설정
const NON_SOURCE_EXTENSIONS = new Set([
    ".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".svg", ".bmp", ".heic",
    ".ttf", ".otf", ".woff", ".woff2", ".eot",
    ".mp3", ".mp4", ".mov", ".wav", ".webm", ".pdf", ".zip",
]);
const NON_SOURCE_FILES = new Set([
    "LICENSE", "LICENCE", "NOTICE", "CHANGELOG", "AUTHORS", "CODEOWNERS", ".gitignore", ".gitattributes",
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "Cargo.lock", "poetry.lock",
    "uv.lock", "Gemfile.lock", "composer.lock", "go.sum", "Podfile.lock",
]);
const NON_SOURCE_PREFIXES = [".claude/", ".design/", ".github/ISSUE_TEMPLATE/"];

export function git(cwd, ...args) {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
    }).trimEnd();
}

function tryGit(cwd, ...args) {
    try {
        return git(cwd, ...args);
    } catch {
        return null;
    }
}

function lines(output) {
    return output ? output.split("\n").filter(Boolean) : [];
}

export function repoRoot(cwd) {
    return tryGit(cwd, "rev-parse", "--show-toplevel");
}

export function isSource(relPath) {
    if (NON_SOURCE_PREFIXES.some((prefix) => relPath.startsWith(prefix))) return false;
    const base = path.basename(relPath);
    if (NON_SOURCE_FILES.has(base)) return false;
    return !NON_SOURCE_EXTENSIONS.has(path.extname(base).toLowerCase());
}

function stateFile(root) {
    const dir = path.resolve(root, git(root, "rev-parse", "--git-path", "security-audit"));
    return { dir, file: path.join(dir, "passed.json") };
}

export function loadState(root) {
    try {
        const state = JSON.parse(readFileSync(stateFile(root).file, "utf8"));
        return { files: state.files ?? {}, history: state.history ?? [] };
    } catch {
        return { files: {}, history: [] };
    }
}

function saveState(root, state) {
    const { dir, file } = stateFile(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

function worktreeHash(root, relPath) {
    return existsSync(path.join(root, relPath)) ? git(root, "hash-object", "--", relPath) : DELETED;
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

function hasHead(root) {
    return tryGit(root, "rev-parse", "-q", "--verify", "HEAD") !== null;
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

// 아직 원격에 없는 커밋들이 바꾼 소스 파일의 HEAD 시점 내용
export function unpushedChanges(root, { upstream } = {}) {
    if (!hasHead(root)) return [];
    let base = null;
    const tracking = upstream ?? tryGit(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
    if (tracking) {
        base = tryGit(root, "merge-base", tracking, "HEAD");
    } else {
        const commits = lines(git(root, "rev-list", "--reverse", "HEAD", "--not", "--remotes"));
        if (commits.length === 0) return [];
        base = tryGit(root, "rev-parse", "-q", "--verify", `${commits[0]}^`) ?? EMPTY_TREE;
    }
    if (!base) return [];

    const changes = [];
    for (const entry of parseNameStatus(git(root, "diff", "--name-status", "-M", base, "HEAD"))) {
        if (!isSource(entry.path)) continue;
        const hash = entry.deleted ? DELETED : git(root, "rev-parse", `HEAD:${entry.path}`);
        changes.push({ path: entry.path, hash, where: "unpushed" });
    }
    return dedupe(changes);
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

export function unaudited(root, changes) {
    const { files } = loadState(root);
    return changes.filter((change) => !(files[change.path] ?? []).includes(change.hash));
}

// 지금 시점의 미커밋·미푸시 소스 내용을 "보안 감사 통과"로 기록한다.
export function markAudited(root, { reason = null } = {}) {
    const state = loadState(root);
    const changes = [...pendingChanges(root), ...unpushedChanges(root)];
    for (const change of changes) {
        const hashes = state.files[change.path] ?? [];
        if (!hashes.includes(change.hash)) hashes.push(change.hash);
        state.files[change.path] = hashes.slice(-MAX_HASHES_PER_FILE);
    }
    const head = hasHead(root) ? git(root, "rev-parse", "HEAD") : null;
    state.history = [
        ...state.history,
        { at: new Date().toISOString(), head, files: changes.length, ...(reason ? { skipped: reason } : {}) },
    ].slice(-50);
    saveState(root, state);
    return changes;
}

export function describe(changes, limit = 8) {
    const names = [...new Set(changes.map((change) => change.path))];
    return names.slice(0, limit).join(", ") + (names.length > limit ? ` 외 ${names.length - limit}개` : "");
}

export function gateDisabled(kind) {
    if (process.env.SECURITY_GATE === "0") return true;
    if (kind === "commit" && process.env.SECURITY_GATE_COMMIT === "0") return true;
    if (kind === "push" && process.env.SECURITY_GATE_PUSH === "0") return true;
    return false;
}
