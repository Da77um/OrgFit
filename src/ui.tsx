// ---------------------------------------------------------------------------
// Shared presentation components.
//
// Every visual decision the product repeats lives here once. The rules this
// module exists to enforce:
//
//   * No component writes a colour, a family or a spacing literal. Everything
//     is a class defined in src/theme.css, which reads the token layers.
//   * No component emits a `style` attribute. Both origins run under a
//     style-src that carries a nonce and no 'unsafe-inline', so an inline
//     style is inert in production — a bar sized that way renders at zero
//     width with no error anywhere. Dynamic geometry is therefore drawn with
//     SVG presentation attributes, which are not CSS.
//   * No status is communicated by colour alone. Badge, Alert and Meter each
//     carry a glyph and a word, so the identity's greyscale-proof rule holds:
//     remove the hue and the meaning survives.
//   * This module is pure presentation. It imports nothing from the data
//     layer, holds no hooks and no handlers, so it is legal in a server
//     component, in a client component, and in the respondent build — which
//     must never link a staff module.
// ---------------------------------------------------------------------------

import type { ReactNode, SVGProps } from "react";

/* -------------------------------------------------------------- identity -- */

// The symbol: three rhombic units on a plumb line, the middle one displaced
// half a unit toward the writing hand and carried in clay. Geometry is copied
// from docs/identityreference/"OrgFit Identity.dc.html", section 01, including
// the 20-degree pen angle and the 24px minimum. `tone` selects the two approved
// renderings: on limestone the offset unit is clay, on ink it is the light clay.
export function Mark({
  tone = "ink",
  className = "",
  ...rest
}: { tone?: "ink" | "inverse" | "flat" } & SVGProps<SVGSVGElement>) {
  const body =
    tone === "inverse" ? "var(--text-inverse)" : tone === "flat" ? "currentColor" : "currentColor";
  const offset =
    tone === "inverse"
      ? "var(--accent-on-dark)"
      : tone === "flat"
        ? "currentColor"
        : "var(--accent)";
  return (
    <svg
      viewBox="8 6 32 58"
      className={className}
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <polygon points="0,-5 6.4,0 0,5 -6.4,0" transform="translate(24,14) rotate(-20)" fill={body} />
      <polygon points="0,-5 6.4,0 0,5 -6.4,0" transform="translate(17,35) rotate(-20)" fill={offset} />
      <polygon points="0,-5 6.4,0 0,5 -6.4,0" transform="translate(24,56) rotate(-20)" fill={body} />
    </svg>
  );
}

// The squared form. The identity permits this one at 16px and requires it for
// the favicon and the system icon; the bare symbol is never used below 24px.
export function MarkTile({ className = "", ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false" {...rest}>
      <rect width="32" height="32" fill="var(--brand-ink)" />
      <polygon
        points="0,-5 6.4,0 0,5 -6.4,0"
        transform="translate(17.5,7.4) rotate(-20) scale(0.62)"
        fill="var(--brand-limestone-light)"
      />
      <polygon
        points="0,-5 6.4,0 0,5 -6.4,0"
        transform="translate(13,16) rotate(-20) scale(0.62)"
        fill="var(--brand-clay-light)"
      />
      <polygon
        points="0,-5 6.4,0 0,5 -6.4,0"
        transform="translate(17.5,24.6) rotate(-20) scale(0.62)"
        fill="var(--brand-limestone-light)"
      />
    </svg>
  );
}

// Lockup A reduced to its one-line application form: mark, then the Latin
// wordmark at the identity's tracking. The Arabic descriptor is dropped here
// because the bar is far below the 120px minimum at which the identity keeps
// it. The accessible name carries the full product name.
export function Lockup({ href, label }: { href?: string; label: string }) {
  const inner = (
    <>
      <Mark tone="inverse" className="appbar-mark" />
      <span className="appbar-word" aria-hidden="true">
        ORGFIT
      </span>
      <span className="visually-hidden">{label}</span>
    </>
  );
  return href ? (
    <a className="appbar-brand" href={href}>
      {inner}
    </a>
  ) : (
    <span className="appbar-brand">{inner}</span>
  );
}

/* ------------------------------------------------------------ typography -- */

// A Latin micro-label: uppercase, tracked, mono, isolated left-to-right so it
// keeps its reading order inside an Arabic line.
//
// LATIN ONLY, and lang="en" says so. Tracking an Arabic word separates letters
// that must stay joined, and uppercasing it does nothing — a localized small
// label is <Label>, not this.
export function Micro({
  children,
  accent = false,
  className = "",
}: {
  children: ReactNode;
  accent?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`micro${accent ? " micro-accent" : ""}${className ? ` ${className}` : ""}`}
      dir="ltr"
      lang="en"
    >
      {children}
    </span>
  );
}

// The localized counterpart: the same role in the hierarchy, set in the body
// face at the document's own direction, with no tracking and no case change.
export function Label({
  children,
  accent = false,
  className = "",
}: {
  children: ReactNode;
  accent?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`label${accent ? " label-accent" : ""}${className ? ` ${className}` : ""}`}
    >
      {children}
    </span>
  );
}

// Any number, identifier, hash, version or timestamp. Tabular, monospaced and
// left-to-right whatever the surrounding direction.
export function Num({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`num${className ? ` ${className}` : ""}`} dir="ltr">
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- status -- */

export type Tone = "neutral" | "positive" | "caution" | "danger" | "accent" | "strong";

// The glyph is the non-colour half of the signal. It is decorative for a
// screen reader, which hears the badge's text instead.
const GLYPH: Record<Tone, string> = {
  neutral: "·",
  positive: "✓",
  caution: "!",
  danger: "×",
  accent: "◆",
  strong: "■",
};

export function Badge({
  tone = "neutral",
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      <span className="badge-glyph" aria-hidden="true">
        {GLYPH[tone]}
      </span>
      <span>{children}</span>
    </span>
  );
}

// A single message with a role. `role` is the caller's decision, not the
// tone's: an assertive alert interrupts a screen reader and most notices in
// this product should not.
export function Alert({
  tone = "info",
  role = "status",
  children,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  role?: "status" | "alert" | "note";
  children: ReactNode;
}) {
  const glyph = tone === "danger" ? "×" : tone === "warning" ? "!" : tone === "success" ? "✓" : "i";
  return (
    <div
      className={`alert alert-${tone}`}
      role={role}
      aria-live={role === "status" ? "polite" : undefined}
    >
      <span className="alert-glyph" aria-hidden="true">
        {glyph}
      </span>
      <div>{children}</div>
    </div>
  );
}

/* ---------------------------------------------------------- absent states -- */

// The four ways a region can have no content. They are deliberately different
// shapes: "nothing here yet" must never be mistaken for "something failed",
// and "you may not see this" must never be mistaken for either.
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="state state-empty">
      <Mark className="state-mark" tone="flat" />
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="state state-loading" role="status" aria-live="polite">
      <Mark className="state-mark" tone="flat" />
      <p>{label}</p>
    </div>
  );
}

export function ErrorState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="state state-error" role="alert">
      <h3>
        <span aria-hidden="true">× </span>
        {title}
      </h3>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}

export function DeniedState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="state state-denied" role="note">
      <h3>
        <span aria-hidden="true">! </span>
        {title}
      </h3>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}

/* ------------------------------------------------------------------ page -- */

export function PageHeader({
  eyebrow,
  title,
  sub,
  meta,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      {eyebrow && <div className="eyebrow">{eyebrow}</div>}
      <div className="row-between row">
        <h1 className="page-title">{title}</h1>
        {actions && <div className="row">{actions}</div>}
      </div>
      {sub && <p className="page-sub">{sub}</p>}
      {meta && <div className="page-meta">{meta}</div>}
    </div>
  );
}

// A single figure with its name. `numeric` decides the face and the reading
// direction: a measurement is mono, tabular and left-to-right, while a word —
// a status, an industry, a timezone name in Arabic — is set in the display face
// at the document's own direction. Left unset it is inferred, because almost
// every caller is passing one or the other and should not have to say so.
export function Tile({
  label,
  value,
  note,
  accent = false,
  numeric,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  accent?: boolean;
  numeric?: boolean;
}) {
  const isNumeric =
    numeric ??
    (typeof value === "number" ||
      (typeof value === "string" && /^[\u0020-\u007E]*$/.test(value)));
  return (
    <div className={`tile${accent ? " tile-accent" : ""}`}>
      <Label>{label}</Label>
      {isNumeric ? (
        <span className="tile-value" dir="ltr">
          {value}
        </span>
      ) : (
        <span className="tile-word">{value}</span>
      )}
      {note && <span className="tile-note">{note}</span>}
    </div>
  );
}

/* ---------------------------------------------------------------- charts -- */

// A single value on a 0..100 track, drawn as SVG.
//
// The width is an SVG attribute rather than a CSS length for a reason that is
// not stylistic: a `style` attribute is blocked by this origin's policy, so a
// CSS-sized bar is silently empty in production. `accent` marks the one value
// a screen is drawing attention to — the identity's rule is that exactly one
// concern is carried in clay.
export function Meter({
  value,
  max = 100,
  label,
  accent = false,
  suffix = "",
}: {
  value: number;
  max?: number;
  label: string;
  accent?: boolean;
  suffix?: string;
}) {
  const clamped = Math.max(0, Math.min(max, value));
  const width = max === 0 ? 0 : (clamped / max) * 100;
  return (
    <div className="meter">
      {/* The number leads: it is the fact, and the bar is the comparison. */}
      <span className="meter-value" aria-hidden="true">
        {value}
        {suffix}
      </span>
      <svg
        viewBox="0 0 100 8"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}: ${value}${suffix} / ${max}${suffix}`}
      >
        <rect className="meter-track" x="0" y="0" width="100" height="8" />
        <rect
          className={accent ? "meter-fill meter-fill-accent" : "meter-fill"}
          x="0"
          y="0"
          width={width}
          height="8"
        />
        <rect className="meter-frame" x="0.5" y="0.5" width="99" height="7" />
      </svg>
    </div>
  );
}

// A trend over ordered points, drawn without axes. It is always accompanied by
// the same numbers in a table, so it carries no label of its own beyond the
// accessible description the caller supplies.
export function Sparkline({
  points,
  label,
  min = 0,
  max = 100,
}: {
  points: number[];
  label: string;
  min?: number;
  max?: number;
}) {
  if (points.length < 2) return null;
  const w = 100,
    h = 28,
    span = max - min || 1;
  const at = (v: number, i: number) =>
    [
      (i / (points.length - 1)) * w,
      h - ((Math.max(min, Math.min(max, v)) - min) / span) * (h - 4) - 2,
    ] as const;
  return (
    <svg
      className="chart"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <polyline className="spark-line" points={points.map((v, i) => at(v, i).join(",")).join(" ")} />
      {points.map((v, i) => {
        const [x, y] = at(v, i);
        return <circle key={i} className="spark-node" cx={x} cy={y} r="1.6" />;
      })}
    </svg>
  );
}

/* -------------------------------------------------------------- overlays -- */

// A presentational dialog. Focus management belongs to the screen that opens
// it, because only that screen knows what to return focus to.
export function Modal({
  title,
  labelledBy,
  children,
  actions,
}: {
  title: ReactNode;
  labelledBy: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="scrim">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        <div className="modal-head">
          <h2 id={labelledBy}>{title}</h2>
        </div>
        {children}
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}
