// ---------------------------------------------------------------------------
// Drawn material for the public overview page: one icon set and three product
// figures.
//
// Everything here is SVG for the same reason the workspace's charts are — the
// origin's style-src carries a nonce and no 'unsafe-inline', so a `style`
// attribute is inert and a computed geometry has to be a presentation
// attribute. It is also the identity's own idiom: hairline rectangles and
// rhombic units, drawn, never a unicode glyph standing in for an icon.
//
// One content rule, enforced by inspection rather than by a type: EVERY NUMBER
// BELOW IS INVENTED. No figure on this page may show, resemble or be derived
// from a real organization's data. The frames that carry them print the word
// "synthetic" in the language the reader is reading, above the fold of the
// figure, not in a caption underneath.
// ---------------------------------------------------------------------------

import type { SVGProps } from "react";
import type { LandingCopy } from "../../../src/landing-i18n";

/* ------------------------------------------------------------------ icons -- */

// One stroke weight, one cap style, one 24-unit box. `.glyph` in landing.css
// carries the stroke so that a rebrand changes it in one place.
function Icon({ children, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...rest}>
      <g className="glyph">{children}</g>
    </svg>
  );
}

// Nested boundaries: an organization containing departments.
export const IconStructure = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="2.5" y="2.5" width="19" height="19" />
    <rect x="6" y="6" width="5.5" height="5.5" />
    <rect x="12.5" y="6" width="5.5" height="5.5" />
    <rect x="6" y="12.5" width="12" height="5.5" />
  </Icon>
);

// A sheet with an instrument's rows on it.
export const IconInstrument = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="4" y="2.5" width="16" height="19" />
    <path d="M7.5 7.5h9M7.5 11.5h9M7.5 15.5h5.5" />
  </Icon>
);

// A campaign: one origin, many invitations, each its own line.
export const IconCampaign = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="2.5" y="9.5" width="5" height="5" />
    <rect x="16.5" y="3" width="5" height="5" />
    <rect x="16.5" y="16" width="5" height="5" />
    <path d="M7.5 11.5h4.5v-6h4.5M7.5 12.5h4.5v6h4.5" />
  </Icon>
);

// Aggregate measurement over time.
export const IconAnalysis = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M3 21V3" />
    <path d="M3 21h18" />
    <rect x="6.5" y="13" width="3.5" height="5" />
    <rect x="12" y="9" width="3.5" height="9" />
    <rect x="17.5" y="5.5" width="3.5" height="12.5" />
  </Icon>
);

// A deterministic rule: one condition, two outcomes.
export const IconRule = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="8.5" y="2.5" width="7" height="7" />
    <rect x="2.5" y="14.5" width="7" height="7" />
    <rect x="14.5" y="14.5" width="7" height="7" />
    <path d="M12 9.5v2.5H6v2.5M12 12h6v2.5" />
  </Icon>
);

// An issued artifact and a visit recorded against it.
export const IconReport = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M4 2.5h11l5 5V21.5H4z" />
    <path d="M15 2.5v5h5" />
    <path d="M7.5 12.5h9M7.5 16.5h6" />
  </Icon>
);

// Separation: two enclosures that share no line.
export const IconSeparation = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="2.5" y="5.5" width="8" height="13" />
    <rect x="13.5" y="5.5" width="8" height="13" />
    <path d="M12 3v18" />
  </Icon>
);

// Aggregation: many marks resolving to one.
export const IconAggregate = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M3 4.5h6M3 9h6M3 13.5h6M3 18h6" />
    <path d="M11 11.25h4" />
    <rect x="15.5" y="7.5" width="6" height="7.5" />
  </Icon>
);

// A threshold: a group below the line is not released.
export const IconThreshold = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M2.5 13.5h19" />
    <rect x="4" y="3" width="4" height="7" />
    <rect x="10" y="6" width="4" height="4" />
    <rect x="16" y="16.5" width="4" height="4.5" />
  </Icon>
);

// The FAQ disclosure marker: a plus that becomes a cross when open, rotated by
// CSS. Drawn rather than a text character, so it matches the icon set.
export const IconDisclose = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M12 4v16M4 12h16" />
  </Icon>
);

// A directional arrow. Mirrored by landing.css under RTL rather than swapped
// for a different glyph.
export const IconBack = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M15 4 7 12l8 8" />
  </Icon>
);

/* ---------------------------------------------------------------- figures -- */

// A hatch used for a withheld cell. Shape, not shade: the identity's greyscale
// rule and the product's own rule that a withheld value must never be able to
// read as a low value.
function Hatch() {
  return (
    <defs>
      <pattern
        id="fig-hatch"
        width="6"
        height="6"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <line x1="0" y1="0" x2="0" y2="6" className="fig-rule" />
      </pattern>
    </defs>
  );
}

// The hero figure: one round's headline reading, its dimensions, and one
// withheld cell with its reason. Numbers invented.
export function RoundFigure({ copy, rtl }: { copy: LandingCopy; rtl: boolean }) {
  const rows = [
    { label: copy.previewDimensions[0], value: 78 },
    { label: copy.previewDimensions[1], value: 61, accent: true },
    { label: copy.previewDimensions[2], value: 72 },
    { label: copy.previewDimensions[3], value: 69 },
    { label: copy.previewDimensions[4], value: null },
  ];
  // SVG has no writing direction. The whole drawing is laid out left to right
  // and flipped as a unit under RTL, with the text nodes flipped back so they
  // stay readable.
  const flip = rtl ? "translate(320,0) scale(-1,1)" : undefined;
  const textFlip = rtl ? "scale(-1,1)" : undefined;
  const label = (
    x: number,
    y: number,
    text: string,
    cls: string,
    anchor: "start" | "end" = "start",
  ) => (
    <g transform={rtl ? `translate(${x},${y}) ${textFlip}` : `translate(${x},${y})`}>
      {/* `start` already follows the inherited writing direction, so it is
          not swapped for RTL: swapping it pushed Arabic labels out of the
          viewBox, which the desktop screenshot showed. */}
      <text className={cls} textAnchor={anchor}>
        {text}
      </text>
    </g>
  );
  return (
    <svg viewBox="0 0 320 208" role="img" aria-label={`${copy.previewTitle} — ${copy.previewSynthetic}`}>
      <Hatch />
      <g transform={flip}>
        {/* Two headline readings */}
        <rect x="0" y="0" width="152" height="46" className="fig-frame" />
        <rect x="168" y="0" width="152" height="46" className="fig-frame" />
        {label(10, 16, copy.previewOverall, "fig-muted")}
        {label(10, 36, "71.4", "fig-value")}
        {label(178, 16, copy.previewParticipation, "fig-muted")}
        {label(178, 36, "84%", "fig-value")}
        <rect x="60" y="30" width="82" height="6" className="fig-track" />
        <rect x="60" y="30" width="58" height="6" className="fig-fill" />
        <rect x="228" y="30" width="82" height="6" className="fig-track" />
        <rect x="228" y="30" width="69" height="6" className="fig-fill" />

        <line x1="0" y1="60" x2="320" y2="60" className="fig-rule" />

        {rows.map((row, i) => {
          const y = 74 + i * 22;
          return (
            <g key={row.label}>
              {label(0, y + 8, row.label, "fig-label")}
              {row.value === null ? (
                <>
                  <rect x="150" y={y} width="120" height="10" className="fig-hatch" />
                  {label(276, y + 8, copy.previewWithheld, "fig-muted")}
                </>
              ) : (
                <>
                  <rect x="150" y={y} width="120" height="10" className="fig-track" />
                  <rect
                    x="150"
                    y={y}
                    width={(row.value / 100) * 120}
                    height="10"
                    className={row.accent ? "fig-fill-accent" : "fig-fill"}
                  />
                  {label(276, y + 8, String(row.value), "fig-value")}
                </>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

// Results board: a small department comparison with one withheld row.
export function ResultsFigure({ rtl }: { rtl: boolean }) {
  const bars = [74, 66, 81, null, 59];
  const flip = rtl ? "translate(280,0) scale(-1,1)" : undefined;
  return (
    <svg viewBox="0 0 280 120" role="img" aria-hidden="true">
      <Hatch />
      <g transform={flip}>
        <line x1="0" y1="100" x2="280" y2="100" className="fig-rule" />
        {bars.map((value, i) => {
          const x = 14 + i * 54;
          const height = value === null ? 34 : (value / 100) * 88;
          return (
            <rect
              key={i}
              x={x}
              y={100 - height}
              width="34"
              height={height}
              className={value === null ? "fig-hatch" : i === 2 ? "fig-fill-accent" : "fig-fill"}
            />
          );
        })}
        <line x1="0" y1="56" x2="280" y2="56" className="fig-rule" strokeDasharray="3 4" />
      </g>
    </svg>
  );
}

// Campaign tracking: invited, completed, not started — three counts and a bar
// that never touches the content of an answer.
export function ParticipationFigure({ rtl }: { rtl: boolean }) {
  const flip = rtl ? "translate(280,0) scale(-1,1)" : undefined;
  return (
    <svg viewBox="0 0 280 120" role="img" aria-hidden="true">
      <g transform={flip}>
        <rect x="0" y="18" width="280" height="18" className="fig-track" />
        <rect x="0" y="18" width="196" height="18" className="fig-fill" />
        <rect x="0.5" y="18.5" width="279" height="17" className="fig-frame" />
        {[0, 1, 2, 3].map((row) => (
          <g key={row}>
            <line
              x1="0"
              y1={62 + row * 16}
              x2="280"
              y2={62 + row * 16}
              className="fig-rule"
            />
            <rect x="0" y={52 + row * 16} width="86" height="5" className="fig-track" />
            <rect
              x="200"
              y={52 + row * 16}
              width="26"
              height="5"
              className={row === 3 ? "fig-track" : "fig-fill"}
            />
          </g>
        ))}
      </g>
    </svg>
  );
}

// Recommendations and visits: a frozen rule resolving into one finding, and a
// follow-up record beside it.
export function RecommendationFigure({ rtl }: { rtl: boolean }) {
  const flip = rtl ? "translate(280,0) scale(-1,1)" : undefined;
  return (
    <svg viewBox="0 0 280 120" role="img" aria-hidden="true">
      <g transform={flip}>
        <rect x="0" y="8" width="96" height="30" className="fig-node" />
        <rect x="0" y="48" width="96" height="30" className="fig-node" />
        <rect x="0" y="88" width="96" height="24" className="fig-node" />
        <path d="M96 23h34v40h26M96 63h60M96 100h34V63" className="fig-link" />
        <rect x="162" y="44" width="118" height="38" className="fig-node-accent" />
        <rect x="172" y="56" width="70" height="5" className="fig-fill-accent" />
        <rect x="172" y="66" width="42" height="4" className="fig-track" />
        <rect x="10" y="18" width="56" height="4" className="fig-track" />
        <rect x="10" y="58" width="66" height="4" className="fig-track" />
        <rect x="10" y="96" width="48" height="4" className="fig-track" />
      </g>
    </svg>
  );
}

// The organization schematic beside the lead capability: one organization, its
// departments, and a participant register that hangs off the departments and
// never off a response.
export function StructureFigure({ rtl }: { rtl: boolean }) {
  const flip = rtl ? "translate(300,0) scale(-1,1)" : undefined;
  return (
    <svg viewBox="0 0 300 150" role="img" aria-hidden="true">
      <g transform={flip}>
        <rect x="110" y="6" width="80" height="26" className="fig-node-accent" />
        <path d="M150 32v18M46 50h208M46 50v14M150 50v14M254 50v14" className="fig-link" />
        {[10, 114, 218].map((x) => (
          <rect key={x} x={x} y="64" width="72" height="24" className="fig-node" />
        ))}
        <path d="M46 88v14M150 88v14M254 88v14" className="fig-link" />
        {[10, 114, 218].map((x) => (
          <g key={x}>
            <rect x={x} y="102" width="72" height="38" className="fig-frame" />
            <rect x={x + 8} y="112" width="40" height="4" className="fig-track" />
            <rect x={x + 8} y="122" width="52" height="4" className="fig-track" />
            <rect x={x + 8} y="132" width="34" height="4" className="fig-track" />
          </g>
        ))}
      </g>
    </svg>
  );
}
