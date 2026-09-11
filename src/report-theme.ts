// ---------------------------------------------------------------------------
// Report theme tokens.
//
// The renderer never writes a colour, a size or a family literal: every visual
// decision in src/report-html.ts reads one of these tokens. An owner who later
// supplies real branding replaces the values here (or through REPORT_THEME) and
// changes nothing else. This is a token table, not a design: the defaults are
// deliberately plain and carry no invented brand.
//
// Values are validated before they reach a stylesheet. A token is a colour, a
// length, a number or a font stack — never arbitrary CSS — so a theme file can
// never inject a rule, a url() or an import into a rendered document.
//
// The defaults below are no longer placeholders. They carry the palette from
// the brand identity package in docs/identityreference/ — ink on limestone,
// with one clay accent — so a rendered report belongs to the same system as the
// screen it was requested from. The mechanism is unchanged: an owner overriding
// these through REPORT_THEME still changes nothing else, and the renderer still
// writes no literal of its own.
//
// Report typography is NOT changed here. The renderer embeds Cairo and Noto
// Sans through src/report-fonts.ts, and swapping those for the identity's Zain
// and IBM Plex families is a font-embedding change with its own PDF evidence to
// produce; it is recorded as remaining Phase 13 work rather than done blind.
// ---------------------------------------------------------------------------

// Bumped with the identity palette: a reader comparing two renderings of the
// same round needs to see that the presentation, not the measurement, changed.
export const REPORT_THEME_VERSION = "1.1.0" as const;

export const defaultReportTheme = {
  "page-width": "210mm",
  "page-margin-top": "20mm",
  "page-margin-bottom": "22mm",
  "page-margin-side": "16mm",
  "ink": "#191614",
  "ink-muted": "#625b53",
  "ink-inverse": "#f7f3ec",
  "surface": "#ffffff",
  "surface-alt": "#f7f3ec",
  "rule": "#cfc7ba",
  "rule-strong": "#191614",
  "accent": "#7e3f22",
  "accent-soft": "#efe8dd",
  "positive": "#3f5f3a",
  "caution": "#7a5c12",
  "negative": "#8a2015",
  "withheld": "#625b53",
  "font-size-base": "10pt",
  "font-size-small": "8.5pt",
  "font-size-h1": "20pt",
  "font-size-h2": "14pt",
  "font-size-h3": "11pt",
  "line-height": "1.6",
  "radius": "0pt",
  "bar-height": "9pt",
} as const;

export type ReportThemeKey = keyof typeof defaultReportTheme;
export type ReportTheme = Record<ReportThemeKey, string>;

// A conservative grammar: hex colour, dimension, unitless number, or a short
// keyword. Everything else — functions, url(), quotes, semicolons, braces — is
// rejected and the default is kept.
const safeValue = /^(#[0-9a-fA-F]{3,8}|-?\d{1,4}(\.\d{1,3})?(mm|cm|pt|px|em|rem|%)?|[a-z]{3,16})$/;

export function reportTheme(
  overrides: Record<string, unknown> = readThemeOverrides(),
): ReportTheme {
  const theme = { ...defaultReportTheme } as ReportTheme;
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in defaultReportTheme)) continue;
    if (typeof value !== "string" || !safeValue.test(value)) continue;
    theme[key as ReportThemeKey] = value;
  }
  return theme;
}

function readThemeOverrides(): Record<string, unknown> {
  const raw = process.env.REPORT_THEME;
  if (!raw || raw.length > 4096) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A malformed theme is a plain report, never a failed release.
    return {};
  }
}

export const themeVariables = (theme: ReportTheme) =>
  Object.entries(theme)
    .map(([key, value]) => `--report-${key}: ${value};`)
    .join("\n  ");
