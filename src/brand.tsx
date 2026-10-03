// ---------------------------------------------------------------------------
// The identity as components: the mark, the drawn wordmark, and the lockup.
//
// The mark's geometry lives in src/brand-mark.ts and is shared with the report
// renderer, so a signature on screen and the same signature in a printed PDF
// are the same figure. This file only turns those shapes into JSX and maps the
// roles onto the theme's custom properties.
//
// No `style` attribute appears anywhere: the CSP carries a nonce and no
// 'unsafe-inline', so colour reaches the SVG through `fill`/`stroke` attributes
// holding var() references, which is permitted markup rather than inline CSS.
// ---------------------------------------------------------------------------

import type { SVGProps } from "react";
import {
  MARK_VIEWBOX,
  markShapes,
  detailFor,
  type MarkDetail,
  type MarkOptions,
  type MarkPalette,
} from "./brand-mark";

// Roles resolve to tokens, never to literal colour, so a theme change moves the
// mark with it and single-colour contexts need no second drawing.
const TOKENS: MarkPalette = {
  ground: "var(--mark-ground, var(--surface))",
  channel: "var(--mark-channel, var(--brand-channel))",
  channelLight: "var(--mark-channel-light, var(--brand-channel-light))",
  core: "var(--mark-core, var(--brand-core))",
  accent: "var(--mark-accent, var(--accent))",
  scatter: "var(--mark-scatter, var(--brand-scatter))",
};

// `seed` is also an SVG presentation attribute, so the DOM props drop it and
// the meaning here is the generator seed from MarkOptions.
export interface MarkProps extends Omit<SVGProps<SVGSVGElement>, "role" | "seed">, MarkOptions {
  /** Rendered size in CSS pixels. Also picks the detail unless one is given. */
  size?: number;
  /** Omit for a decorative mark; supply it when the mark is the only label. */
  title?: string;
}

/**
 * The mark. With no scores it draws the balanced figure, which is the logo;
 * with an organization's scores it draws that organization's signature.
 */
export function Mark({
  size = 120,
  scores,
  detail,
  seed,
  concern,
  monochrome,
  title,
  ...rest
}: MarkProps) {
  const level: MarkDetail = detail ?? detailFor(size);
  const shapes = markShapes({ scores, detail: level, seed, concern, monochrome });
  const paint = (role?: string) => (role ? (TOKENS[role as keyof MarkPalette] ?? role) : undefined);
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      width={size}
      height={size}
      direction="ltr"
      xmlns="http://www.w3.org/2000/svg"
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      {...rest}
    >
      {shapes.map((s, i) => {
        if (s.kind === "circle")
          return (
            <circle
              key={i}
              cx={s.cx}
              cy={s.cy}
              r={s.r}
              fill={s.fill ? paint(s.fill) : "none"}
              fillOpacity={s.opacity}
              stroke={paint(s.stroke)}
              strokeWidth={s.width}
            />
          );
        if (s.kind === "line")
          return (
            <line
              key={i}
              x1={s.x1}
              y1={s.y1}
              x2={s.x2}
              y2={s.y2}
              stroke={paint(s.stroke)}
              strokeWidth={s.width}
              strokeOpacity={s.opacity}
              strokeLinecap="square"
            />
          );
        if (s.kind === "polygon")
          return <polygon key={i} points={s.points.map(([x, y]) => `${x},${y}`).join(" ")} fill={paint(s.fill)} />;
        return (
          <polyline
            key={i}
            points={s.points.map(([x, y]) => `${x},${y}`).join(" ")}
            fill="none"
            stroke={paint(s.stroke)}
            strokeWidth={s.width}
            strokeOpacity={s.opacity}
            strokeDasharray={s.dash}
          />
        );
      })}
    </svg>
  );
}

// --- the wordmark ----------------------------------------------------------
// Drawn, not set: no typeface ships these shapes. One stroke weight of 13 on a
// cap height of 100. Three letters carry the concept — O is the core, F's arms
// end in channel nodes, and the tittle on the i is the clay rhombus that marks
// a concern elsewhere in the system.

const WORDMARK_STROKE = 13;

export interface WordmarkProps extends Omit<SVGProps<SVGSVGElement>, "role"> {
  /** Cap height in CSS pixels. The drawing scales from this. */
  cap?: number;
  /** Collapse to one ink for single-colour and reversed use. */
  monochrome?: boolean;
}

export function Wordmark({ cap = 40, monochrome = false, ...rest }: WordmarkProps) {
  const ink = "var(--wordmark-ink, var(--text))";
  const node = monochrome ? ink : "var(--wordmark-node, var(--brand-channel-light))";
  const tittle = monochrome ? ink : "var(--wordmark-tittle, var(--accent))";
  const k = cap / 100;
  const common = { fill: "none", stroke: ink, strokeWidth: WORDMARK_STROKE } as const;
  return (
    <svg
      viewBox="-4 -6 428 164"
      width={428 * k}
      height={164 * k}
      direction="ltr"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="OrgFit"
      {...rest}
    >
      {/* O — a ring around a solid core: the name opens on the nucleus. */}
      <circle cx={50} cy={50} r={43.5} {...common} />
      <circle cx={50} cy={50} r={13} fill={ink} />
      {/* r */}
      <path d="M122.5 100 V65 A28.5 28.5 0 0 1 151 36.5 H163" {...common} />
      {/* g */}
      <circle cx={207} cy={65} r={28.5} {...common} />
      <path d="M235.5 30 V118 A28.5 28.5 0 0 1 178.5 118" {...common} />
      {/* F — the arms are channels and they end in nodes. */}
      <path d="M266.5 100 V6.5 H316 M266.5 52 H300" {...common} />
      <circle cx={322} cy={6.5} r={10.5} fill={node} />
      <circle cx={306} cy={52} r={10.5} fill={node} />
      {/* i — the tittle is the rhombic concern mark. */}
      <path d="M352.5 30 V100" {...common} />
      <polygon points="352.5,0 363,10.5 352.5,21 342,10.5" fill={tittle} />
      {/* t */}
      <path d="M389.5 10 V82 A18 18 0 0 0 407.5 100 H418 M373 36.5 H414" {...common} />
    </svg>
  );
}

/**
 * Mark and wordmark together with the rule between them. `descriptor` is the
 * Arabic line; it leads, and the Latin name sits above it.
 */
export function Lockup({
  descriptor,
  cap = 30,
  markSize = 96,
  monochrome = false,
}: {
  descriptor?: string;
  cap?: number;
  markSize?: number;
  monochrome?: boolean;
}) {
  return (
    <span className="lockup">
      <Mark size={markSize} concern={false} monochrome={monochrome} />
      <span className="lockup-rule" />
      <span className="lockup-text">
        <Wordmark cap={cap} monochrome={monochrome} />
        {descriptor ? <span className="lockup-descriptor">{descriptor}</span> : null}
      </span>
    </span>
  );
}
