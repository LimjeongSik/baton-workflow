#!/usr/bin/env node
// 디자인 계획의 팔레트에서 "AI가 만든 티"가 나는 기본값 패턴과 대비 문제를 찾는다.
//
// 사용법:
//   node palette-check.mjs --bg "#F2F4F0" --fg "#1F2421" "#2F6B4F" "#E8B04B" ...
//
// --bg: 주 배경, --fg: 본문 글자색, 나머지: 강조·보조색.
// 경고는 금지가 아니다. 근거가 있으면 유지하고, 근거가 없으면 바꾸라는 신호다.

const TAILWIND_DEFAULTS = {
    "#0F172A": "slate-900",
    "#1E293B": "slate-800",
    "#334155": "slate-700",
    "#F8FAFC": "slate-50",
    "#111827": "gray-900",
    "#1F2937": "gray-800",
    "#F9FAFB": "gray-50",
    "#F3F4F6": "gray-100",
    "#18181B": "zinc-900",
    "#171717": "neutral-900",
    "#3B82F6": "blue-500",
    "#2563EB": "blue-600",
    "#0EA5E9": "sky-500",
    "#6366F1": "indigo-500",
    "#4F46E5": "indigo-600",
    "#8B5CF6": "violet-500",
    "#7C3AED": "violet-600",
    "#A855F7": "purple-500",
    "#EC4899": "pink-500",
    "#10B981": "emerald-500",
    "#22C55E": "green-500",
    "#F59E0B": "amber-500",
    "#EF4444": "red-500",
};

const GENERATED_TELLS = {
    "#D97757": "테라코타 강조 (frontend-design이 꼽은 기본값)",
    "#0B0B0B": "검정 대신 쓰는 틴트 블랙",
    "#111111": "검정 대신 쓰는 틴트 블랙",
    "#0B1120": "네이비 다크 배경",
};

function parseHex(input) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    const n = Number.parseInt(h, 16);
    return { hex: `#${h.toUpperCase()}`, r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function toHsl({ r, g, b }) {
    const [rn, gn, bn] = [r / 255, g / 255, b / 255];
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: l * 100 };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    return { h: h * 60, s: s * 100, l: l * 100 };
}

function luminance({ r, g, b }) {
    const ch = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

// 사람 눈 기준 색차(CIE76 ΔE). 밝은 색끼리는 RGB 거리가 늘 가까워서 오탐이 난다.
function toLab({ r, g, b }) {
    const lin = (v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const [R, G, B] = [lin(r), lin(g), lin(b)];
    const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
    const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
    const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function distance(a, b) {
    const [l1, a1, b1] = toLab(a);
    const [l2, a2, b2] = toLab(b);
    return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

function nearest(color, table, threshold) {
    for (const [hex, name] of Object.entries(table)) {
        const ref = parseHex(hex);
        if (distance(color, ref) < threshold) return `${name} (${hex})`;
    }
    return null;
}

function inspect(color, role) {
    const { h, s, l } = toHsl(color);
    const warnings = [];

    const tailwind = nearest(color, TAILWIND_DEFAULTS, 2.5);
    if (tailwind) warnings.push(`Tailwind 기본 팔레트 ${tailwind}와 거의 같다`);

    const tell = nearest(color, GENERATED_TELLS, 5);
    if (tell) warnings.push(`생성형 디자인에서 흔한 값: ${tell}`);

    if (role === "bg" && h >= 30 && h <= 55 && s >= 20 && l >= 90 && l <= 97) {
        warnings.push("따뜻한 크림 배경 (frontend-design이 꼽은 기본값). 주제에서 나온 근거가 필요하다");
    }

    if (l < 22 && s > 12 && h >= 195 && h <= 255) {
        warnings.push("네이비·슬레이트 계열 다크. 다크 테마가 요청이나 분야 관례라는 근거가 필요하다");
    } else if (role === "bg" && l < 20) {
        warnings.push("다크 배경. 요청이나 분야 관례라는 근거가 필요하다");
    }

    if (h >= 230 && h <= 290 && s > 40 && l > 30 && l < 72) {
        warnings.push("인디고·보라 계열 강조. 주제에서 나온 근거가 필요하다");
    }

    if (s < 3 && l > 8 && l < 95) {
        warnings.push("순수 회색. 주조색 쪽으로 살짝 틴트하면 성격이 생긴다");
    } else if (s >= 4 && s < 20 && h >= 200 && h <= 230 && l > 8 && l < 97 && role !== "accent") {
        warnings.push("차가운 파란 회색(슬레이트) 중립색. 주조색과 관계가 있는지 확인한다");
    }

    return { hsl: `H${Math.round(h)} S${Math.round(s)}% L${Math.round(l)}%`, warnings };
}

const args = process.argv.slice(2);
let bg = null;
let fg = null;
const accents = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === "--bg") bg = args[++i];
    else if (args[i] === "--fg") fg = args[++i];
    else accents.push(args[i]);
}

if (!bg && !fg && accents.length === 0) {
    console.error('사용법: node palette-check.mjs --bg "#F2F4F0" --fg "#1F2421" "#2F6B4F" ...');
    process.exit(2);
}

const entries = [
    ...(bg ? [["bg", bg]] : []),
    ...(fg ? [["fg", fg]] : []),
    ...accents.map((c) => ["accent", c]),
];

const ROLE = { bg: "배경", fg: "본문", accent: "강조·보조" };
const bgColor = bg ? parseHex(bg) : null;
let warningCount = 0;

for (const [role, raw] of entries) {
    const color = parseHex(raw);
    if (!color) {
        console.log(`✖ ${raw}: hex 형식이 아니다`);
        warningCount++;
        continue;
    }
    const { hsl, warnings } = inspect(color, role);
    let line = `${warnings.length ? "⚠" : "✓"} ${color.hex} [${ROLE[role]}] ${hsl}`;
    if (bgColor && role !== "bg") line += `  배경 대비 ${contrast(color, bgColor).toFixed(2)}:1`;
    console.log(line);
    for (const w of warnings) console.log(`    - ${w}`);
    warningCount += warnings.length;
}

if (bgColor && fg) {
    const fgColor = parseHex(fg);
    if (fgColor) {
        const ratio = contrast(fgColor, bgColor);
        if (ratio < 4.5) {
            console.log(`⚠ 본문 대비 ${ratio.toFixed(2)}:1. WCAG AA 본문 기준 4.5:1에 못 미친다`);
            warningCount++;
        }
    }
}
if (bgColor) {
    for (const raw of accents) {
        const c = parseHex(raw);
        if (c && contrast(c, bgColor) < 3) {
            console.log(`ℹ ${c.hex}는 배경 대비 3:1 미만이다. 글자나 UI 경계에 쓰면 안 되고, 면 채우기용으로만 쓴다`);
        }
    }
}

console.log(warningCount === 0 ? "\n경고 없음" : `\n경고 ${warningCount}건. 근거가 있으면 보고에 적고 유지하고, 없으면 바꾼다.`);
