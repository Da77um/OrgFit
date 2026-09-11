import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Locale } from "./i18n";

// ---------------------------------------------------------------------------
// Report fonts.
//
// A rendered report embeds its own faces and reads nothing from the network or
// from the host's installed fonts: a renderer with no fonts installed and no
// network must produce the same document. Every face is inlined as a data URI,
// and the renderer additionally asserts that zero network requests were made.
//
// Both families are SIL Open Font License 1.1, which permits embedding in a
// document. This is a development choice with a license that allows it, not the
// owner's brand decision: P-007 still owns the final family and its license.
//
// Cairo is used for Arabic for a measured reason rather than a stylistic one.
// The renderer's PDF writer derives its ToUnicode mapping from the embedded
// face, and with Noto Naskh Arabic or Noto Sans Arabic roughly a quarter of the
// shaped glyphs had no reverse mapping — the Arabic rendered correctly but was
// not fully copyable or searchable. With Cairo the same page maps every glyph.
// See docs/orgfit/reports.md and D-078.
// ---------------------------------------------------------------------------

export const FONT_LICENSE = "SIL Open Font License 1.1" as const;
export const FONT_FAMILIES = {
  arabic: { family: "OrgFit Arabic", source: "Cairo", license: FONT_LICENSE },
  latin: { family: "OrgFit Latin", source: "Noto Sans", license: FONT_LICENSE },
} as const;

const require = createRequire(import.meta.url);

const faces = [
  { family: "OrgFit Arabic", weight: 400, package: "@fontsource/cairo", file: "cairo-arabic-400-normal.woff2" },
  { family: "OrgFit Arabic", weight: 700, package: "@fontsource/cairo", file: "cairo-arabic-700-normal.woff2" },
  { family: "OrgFit Arabic", weight: 400, package: "@fontsource/cairo", file: "cairo-latin-400-normal.woff2" },
  { family: "OrgFit Arabic", weight: 700, package: "@fontsource/cairo", file: "cairo-latin-700-normal.woff2" },
  { family: "OrgFit Latin", weight: 400, package: "@fontsource/noto-sans", file: "noto-sans-latin-400-normal.woff2" },
  { family: "OrgFit Latin", weight: 700, package: "@fontsource/noto-sans", file: "noto-sans-latin-700-normal.woff2" },
] as const;

const packageDirectory = (name: string) =>
  dirname(require.resolve(`${name}/package.json`));

let cached: string | undefined;

/** Every face as @font-face rules with inline data URIs. Read once per process. */
export async function fontFaceCss() {
  if (cached) return cached;
  const rules: string[] = [];
  for (const face of faces) {
    const path = join(packageDirectory(face.package), "files", face.file);
    const bytes = await readFile(path);
    rules.push(
      `@font-face{font-family:"${face.family}";font-style:normal;font-weight:${face.weight};` +
        `font-display:block;src:url(data:font/woff2;base64,${bytes.toString("base64")}) format("woff2");}`,
    );
  }
  cached = rules.join("\n");
  return cached;
}

export const fontStack = (locale: Locale) =>
  locale === "en"
    ? '"OrgFit Latin","OrgFit Arabic",sans-serif'
    : '"OrgFit Arabic","OrgFit Latin",sans-serif';
