// ---------------------------------------------------------------------------
// The identity mark, as geometry rather than as a picture.
//
// One source of shapes, two renderers. The screen draws it as JSX
// (src/brand.tsx) and the report draws it as an SVG string
// (src/report-html.ts), and because both read the arrays below they cannot
// drift apart. Nothing here imports React, the DOM or any database module, so
// the file is usable from a worker and from the renderer alike.
//
// WHAT IT MEANS. Five axes, one for each assessment dimension, in the order the
// scoring module reports them. Each axis is a CHANNEL carrying scattered data
// inward to a solid CORE: the periphery is raw, the centre is knowledge. An
// axis is as long as its dimension scored, so a balanced organization draws the
// regular figure used as the logo and every other organization draws its own
// deviation from it. Identical scores always produce an identical figure; there
// is no randomness anywhere in this file and the scatter field is derived from
// a caller-supplied seed.
//
// THE ONE COLOURED PART. At most one axis is clay: the single lowest dimension
// scoring below the threshold, which is the same rule the report already
// applies. Its end node is drawn as a rhombus rather than a circle, so the
// concern survives greyscale and single-colour print, where colour carries
// nothing. If no dimension is below the threshold, nothing is clay.
// ---------------------------------------------------------------------------

/** Detail is chosen by rendered size, never by taste. See `detailFor`. */
export type MarkDetail = "full" | "reduced" | "seal";

export type MarkShape =
  | { kind: "circle"; cx: number; cy: number; r: number; fill?: string; stroke?: string; width?: number; opacity?: number }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; stroke: string; width: number; opacity?: number }
  | { kind: "polygon"; points: [number, number][]; fill: string }
  | { kind: "polyline"; points: [number, number][]; stroke: string; width: number; opacity?: number; dash?: string };

export type MarkRole = "ground" | "channel" | "channelLight" | "core" | "accent" | "scatter";

/** Caller maps roles to real tokens, so this file holds no colour values. */
export type MarkPalette = Record<MarkRole, string>;

export const MARK_VIEWBOX = "-100 -100 200 200";

/** Below this, a dimension is the organization's concern. Mirrors the report. */
export const MARK_THRESHOLD = 55;

/**
 * Pick detail from the size the mark will actually occupy, in CSS pixels. The
 * full figure carries roughly a hundred elements and is illegible under about
 * 96px; a list of fifty organizations must not pay for it.
 */
export function detailFor(px: number): MarkDetail {
  if (px >= 96) return "full";
  if (px >= 40) return "reduced";
  return "seal";
}

/** Index of the single lowest dimension below the threshold, or null. */
export function concernIndex(scores: readonly number[]): number | null {
  let at = -1;
  for (let i = 0; i < scores.length; i += 1)
    if (scores[i] < MARK_THRESHOLD && (at === -1 || scores[i] < scores[at])) at = i;
  return at === -1 ? null : at;
}

// A small deterministic generator. The scatter field must be identical for the
// same organization on screen, in the PDF and a year later, so Math.random is
// not an option and the sequence is pinned here.
function sequence(seed: number): () => number {
  let s = (Math.abs(Math.trunc(seed)) % 2147483647) || 1;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

export interface MarkOptions {
  /** One score per dimension, 0..100, in the scoring module's order. */
  scores?: readonly number[];
  detail?: MarkDetail;
  /** Stable per organization. Use the numeric part of its reference. */
  seed?: number;
  /** Draw the concern in clay. False for the logo, which has no concern. */
  concern?: boolean;
  /** Single-colour output: every role collapses to one ink. */
  monochrome?: boolean;
}

/**
 * The balanced figure. This is the logo: what an organization with no concern
 * and full scores would draw.
 */
export const MARK_BALANCED: readonly number[] = [100, 100, 100, 100, 100];

export function markShapes(options: MarkOptions = {}): MarkShape[] {
  const {
    scores = MARK_BALANCED,
    detail = "full",
    seed = 1,
    concern = true,
    monochrome = false,
  } = options;

  const ground: MarkRole = "ground";
  const channel: MarkRole = monochrome ? "core" : "channel";
  const light: MarkRole = monochrome ? "core" : "channelLight";
  const accent: MarkRole = monochrome ? "core" : "accent";
  const scatter: MarkRole = monochrome ? "core" : "scatter";

  const at = concern ? concernIndex(scores) : null;
  const out: MarkShape[] = [];

  const full = detail === "full";
  const strokeW = full ? 2.2 : detail === "reduced" ? 4.5 : 9;
  const nodeR = full ? 7 : detail === "reduced" ? 11 : 17;
  const coreR = full ? 13 : detail === "reduced" ? 18 : 24;

  // Axis length is the score. The floor keeps a zero-scoring dimension visible
  // as a short arm rather than collapsing it into the core.
  const reach = (score: number) =>
    (detail === "seal" ? 40 : 34) + (detail === "seal" ? 36 : 38) * (Math.max(0, Math.min(100, score)) / 100);

  const axes = scores.map((score, i) => {
    const angle = ((-90 + 72 * i) * Math.PI) / 180;
    return { angle, length: reach(score), concerned: i === at };
  });

  // 1. The scattered field: raw, unordered, outside the structure.
  if (full) {
    const rand = sequence(seed);
    for (let i = 0; i < 54; i += 1) {
      const a = rand() * Math.PI * 2;
      const r = 78 + rand() * 20;
      out.push({
        kind: "circle",
        cx: r * Math.cos(a),
        cy: r * Math.sin(a),
        r: 0.8 + rand() * 1.3,
        fill: scatter,
        opacity: 0.22 + rand() * 0.42,
      });
    }
  }

  // 2. The channels: structure drawn through the scatter toward the core.
  if (full)
    out.push({
      kind: "polyline",
      points: [...axes, axes[0]].map((x) => [x.length * Math.cos(x.angle), x.length * Math.sin(x.angle)]),
      stroke: channel,
      width: 0.9,
      opacity: 0.35,
      dash: "2.5 3",
    });

  for (const axis of axes) {
    const stroke = axis.concerned ? accent : channel;
    const inner = coreR + (full ? 7 : 4);
    const x0 = inner * Math.cos(axis.angle);
    const y0 = inner * Math.sin(axis.angle);
    const x1 = axis.length * Math.cos(axis.angle);
    const y1 = axis.length * Math.sin(axis.angle);
    out.push({ kind: "line", x1: x0, y1: y0, x2: x1, y2: y1, stroke, width: strokeW });

    if (full) {
      const mid = inner + (axis.length - inner) * 0.52;
      const mx = mid * Math.cos(axis.angle);
      const my = mid * Math.sin(axis.angle);
      for (const spread of [-32, 32]) {
        const b = axis.angle + (spread * Math.PI) / 180;
        const tx = mx + 12 * Math.cos(b);
        const ty = my + 12 * Math.sin(b);
        out.push({ kind: "line", x1: mx, y1: my, x2: tx, y2: ty, stroke, width: 1.2, opacity: 0.8 });
        out.push({ kind: "circle", cx: tx, cy: ty, r: 2.3, fill: axis.concerned ? accent : light });
      }
      out.push({ kind: "circle", cx: mx, cy: my, r: 3.6, fill: stroke });
    }

    // 3. The node. A rhombus marks the concern, so form carries it, not colour.
    if (axis.concerned) {
      const d = nodeR * 1.25;
      out.push({
        kind: "polygon",
        points: [
          [x1, y1 - d],
          [x1 + d, y1],
          [x1, y1 + d],
          [x1 - d, y1],
        ],
        fill: accent,
      });
    } else {
      out.push({ kind: "circle", cx: x1, cy: y1, r: nodeR, fill: ground, stroke, width: strokeW * 1.1 });
      if (full) out.push({ kind: "circle", cx: x1, cy: y1, r: nodeR * 0.42, fill: light });
    }
  }

  // 4. The core: solid knowledge, the end of every channel.
  if (full) out.push({ kind: "circle", cx: 0, cy: 0, r: coreR + 7, stroke: channel, width: 1.2 });
  out.push({ kind: "circle", cx: 0, cy: 0, r: coreR, fill: monochrome ? "core" : "core" });
  if (full) out.push({ kind: "circle", cx: 0, cy: 0, r: coreR * 0.38, fill: ground });

  return out;
}

const round = (n: number) => String(Math.round(n * 100) / 100);

/**
 * Server-side renderer, for `src/report-html.ts` and anything else building an
 * SVG string. `palette` maps each role to a literal colour, because a printed
 * report cannot resolve a CSS custom property.
 */
export function markSvgString(
  options: MarkOptions & { palette: MarkPalette; size: number; title: string },
): string {
  const { palette, size, title, ...rest } = options;
  const body = markShapes(rest)
    .map((s) => {
      const paint = (role: string) => palette[role as MarkRole] ?? role;
      if (s.kind === "circle")
        return `<circle cx="${round(s.cx)}" cy="${round(s.cy)}" r="${round(s.r)}"${
          s.fill ? ` fill="${paint(s.fill)}"` : ' fill="none"'
        }${s.stroke ? ` stroke="${paint(s.stroke)}" stroke-width="${round(s.width ?? 1)}"` : ""}${
          s.opacity === undefined ? "" : ` fill-opacity="${round(s.opacity)}"`
        }></circle>`;
      if (s.kind === "line")
        return `<line x1="${round(s.x1)}" y1="${round(s.y1)}" x2="${round(s.x2)}" y2="${round(
          s.y2,
        )}" stroke="${paint(s.stroke)}" stroke-width="${round(s.width)}"${
          s.opacity === undefined ? "" : ` stroke-opacity="${round(s.opacity)}"`
        } stroke-linecap="square"></line>`;
      if (s.kind === "polygon")
        return `<polygon points="${s.points.map(([x, y]) => `${round(x)},${round(y)}`).join(" ")}" fill="${paint(
          s.fill,
        )}"></polygon>`;
      return `<polyline points="${s.points.map(([x, y]) => `${round(x)},${round(y)}`).join(" ")}" fill="none" stroke="${paint(
        s.stroke,
      )}" stroke-width="${round(s.width)}"${s.opacity === undefined ? "" : ` stroke-opacity="${round(s.opacity)}"`}${
        s.dash ? ` stroke-dasharray="${s.dash}"` : ""
      }></polyline>`;
    })
    .join("");
  // direction="ltr" for the same reason the report's other figures carry it:
  // an RTL ancestor must not mirror a measured drawing.
  return `<svg viewBox="${MARK_VIEWBOX}" width="${size}" height="${size}" direction="ltr" role="img" aria-label="${title}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

/**
 * The seed for an organization's signature, from its own immutable reference:
 * the leading 32 bits of its id (a UUID), read as a number. The organization
 * code is not used because staff can edit it, which would redraw the scatter
 * field of a published signature. The screen and the report both call this,
 * so the same organization draws the same figure in both.
 */
export function seedFor(organizationId: string): number {
  const lead = Number.parseInt(organizationId.replace(/[^0-9a-f]/gi, "").slice(0, 8), 16);
  return Number.isFinite(lead) ? lead % 2147483647 || 1 : 1;
}

/**
 * The five scores a signature draws, or null when the figure would claim more
 * than was published. Every dimension must be present and released; a withheld
 * dimension is never drawn at any length, because an arm of any length is a
 * claim about a number.
 */
export function signatureScores(values: readonly (number | null)[]): number[] | null {
  if (values.length !== 5) return null;
  if (values.some((v) => v === null || !Number.isFinite(v))) return null;
  return values as number[];
}
