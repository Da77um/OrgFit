import { chromium, type Browser } from "playwright";
import type { ReportModel } from "./report-model";
import { fontFaceCss } from "./report-fonts";
import { reportTheme } from "./report-theme";
import {
  reportHtml,
  reportFooterTemplate,
  reportHeaderTemplate,
} from "./report-html";

// ---------------------------------------------------------------------------
// The PDF renderer.
//
// A paged browser engine produces the file. That choice is about Arabic: the
// report must shape and order Arabic correctly beside Latin words and Latin
// digits, wrap long Arabic paragraphs, repeat table headers across pages and
// still hand the reader selectable text. A hand-written PDF writer would have
// had to reimplement the Unicode bidirectional algorithm and Arabic joining,
// and would have done it worse.
//
// The renderer is sealed rather than trusted:
//   * The document is loaded with setContent, never from a URL.
//   * The context is offline and every request is aborted; the count of
//     attempted requests is returned so a caller can assert it stayed zero.
//     A report that silently fetched something is a report that leaked a
//     reference to it.
//   * No script runs in the page: the document contains no <script>, and
//     JavaScript is disabled in the context anyway.
// ---------------------------------------------------------------------------

export type RenderedPdf = {
  bytes: Buffer;
  pageCount: number | null;
  networkAttempts: number;
};

export async function openReportBrowser(): Promise<Browser> {
  return chromium.launch({
    args: ["--disable-gpu", "--font-render-hinting=none"],
  });
}

export async function renderReportPdf(
  browser: Browser,
  model: ReportModel,
): Promise<RenderedPdf> {
  const theme = reportTheme();
  const fontCss = await fontFaceCss();
  const context = await browser.newContext({
    javaScriptEnabled: false,
    offline: true,
    locale: model.locale === "en" ? "en-US" : "ar",
    reducedMotion: "reduce",
  });
  let networkAttempts = 0;
  await context.route("**/*", (route) => {
    networkAttempts++;
    return route.abort();
  });
  try {
    const page = await context.newPage();
    await page.setContent(reportHtml(model, fontCss, theme), {
      waitUntil: "load",
    });
    await page.emulateMedia({ media: "print" });
    const bytes = Buffer.from(
      await page.pdf({
        format: "A4",
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: true,
        headerTemplate: reportHeaderTemplate(model, theme),
        footerTemplate: reportFooterTemplate(model, fontCss, theme),
        margin: {
          top: theme["page-margin-top"],
          bottom: theme["page-margin-bottom"],
          left: theme["page-margin-side"],
          right: theme["page-margin-side"],
        },
      }),
    );
    return { bytes, pageCount: pdfPageCount(bytes), networkAttempts };
  } finally {
    await context.close();
  }
}

// A best-effort structural read of the page tree for the job record. It is
// evidence, not a contract: a null page count never fails a render.
export function pdfPageCount(bytes: Buffer): number | null {
  const text = bytes.toString("latin1");
  const counts = [...text.matchAll(/\/Type\s*\/Pages\b[\s\S]{0,400}?\/Count\s+(\d+)/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (counts.length) return Math.max(...counts);
  const pages = text.match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;
  return pages > 0 ? pages : null;
}
