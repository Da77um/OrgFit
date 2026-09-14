import test from "node:test";
import assert from "node:assert/strict";
import { checkAnswer, normalizeNumerals } from "../src/answer-rules";
import { validateAnswers, ScoringError } from "../src/scoring";
import { newQuestion, blankInstrument, newIdentity, tr } from "../src/instrument-input";
import {
  formatInZone,
  formatUtc,
  instantToWallClock,
  wallClockToInstant,
} from "../src/zoned-time";
import { ar as staffAr, en as staffEn } from "../src/i18n";
import { respondentAr, respondentEn, fill } from "../src/respondent-i18n";
import { campaignMessages } from "../src/campaign-i18n";
import { visitMessages } from "../src/visits-i18n";
import { adminMessages } from "../src/admin-i18n";
import { resultsMessages } from "../src/results-i18n";
import { AUDIT_ACTIONS } from "../src/administration";

// Phase 13: locale-independent canonical values, per-field answer rules that
// agree with the server, and wall-clock time in a record's own timezone.

test("L-1 numerals: Arabic-Indic, Persian, Arabic decimal separator and minus become canonical Latin", () => {
  assert.equal(normalizeNumerals("١٢٣"), "123");
  assert.equal(normalizeNumerals("۴۵۶"), "456");
  assert.equal(normalizeNumerals("٣٫٥"), "3.5");
  assert.equal(normalizeNumerals("−٧"), "-7");
  // Invisible direction marks a mixed-direction keyboard inserts, and edges.
  assert.equal(normalizeNumerals("‏ ٤٢ ‎"), "42");
  // Nothing is guessed: a thousands separator stays and is refused later.
  assert.equal(normalizeNumerals("1,000"), "1,000");
  assert.equal(normalizeNumerals("١٬٠٠٠"), "1٬000");
});

test("L-2 answer rules name the broken rule, and the server still reports one public code", () => {
  const number = newQuestion("NUMBER");
  number.validation = { min: "0", max: "100", precision: 1 };
  assert.deepEqual(checkAnswer(number, "٤٢٫٥"), { ok: true, value: "42.5" });
  assert.deepEqual(checkAnswer(number, "42.55"), { ok: false, issue: "NUMBER_PRECISION" });
  assert.deepEqual(checkAnswer(number, "١٠١"), { ok: false, issue: "NUMBER_MAX" });
  assert.deepEqual(checkAnswer(number, "-1"), { ok: false, issue: "NUMBER_MIN" });
  assert.deepEqual(checkAnswer(number, "1,000"), { ok: false, issue: "NUMBER_FORMAT" });
  assert.deepEqual(checkAnswer(number, "abc"), { ok: false, issue: "NUMBER_FORMAT" });

  const date = newQuestion("DATE");
  date.validation = { minDate: "2026-01-01", maxDate: "2026-12-31" };
  assert.equal(checkAnswer(date, "2026-02-30").ok, false);
  assert.deepEqual(checkAnswer(date, "2025-12-31"), { ok: false, issue: "DATE_MIN" });
  assert.deepEqual(checkAnswer(date, "2027-01-01"), { ok: false, issue: "DATE_MAX" });
  assert.deepEqual(checkAnswer(date, "2026-02-28"), { ok: true, value: "2026-02-28" });
  // Years below 100 are real ISO years, not 1900 + n.
  const open = newQuestion("DATE");
  assert.equal(checkAnswer(open, "0050-03-01").ok, true);

  const boxes = newQuestion("CHECKBOXES");
  boxes.validation = { minSelections: 2, maxSelections: 2 };
  boxes.options.push({ ...newIdentity(), label: tr("ج", "C"), score: "2" });
  const [a, b, c] = boxes.options.map((o) => o.id);
  assert.deepEqual(checkAnswer(boxes, [a]), { ok: false, issue: "TOO_FEW" });
  assert.deepEqual(checkAnswer(boxes, [a, b, c]), { ok: false, issue: "TOO_MANY" });
  assert.deepEqual(checkAnswer(boxes, [a, a]), { ok: false, issue: "INVALID" });

  const text = newQuestion("SHORT_TEXT");
  text.validation = { maxLength: 3 };
  assert.deepEqual(checkAnswer(text, "أبجد"), { ok: false, issue: "TOO_LONG" });

  // The engine's public contract is unchanged: one code, canonical digits kept.
  const d = blankInstrument();
  d.sections = [{ ...newIdentity(), title: tr("ق", "S"), content: tr(), questions: [number, date] }];
  const accepted = validateAnswers(d, { [number.id]: "٤٢٫٥", [date.id]: "2026-05-01" });
  assert.equal(accepted.answers[number.id], "42.5");
  assert.throws(
    () => validateAnswers(d, { [number.id]: "١٠١" }),
    (e: unknown) =>
      e instanceof ScoringError &&
      e.issues[0].path === number.id &&
      e.issues[0].code === "ANSWER_RANGE",
  );
});

test("L-3 wall-clock time is read and shown in the record's timezone, not the browser's", () => {
  // 10:00 in Riyadh (UTC+3, no DST) is 07:00Z.
  assert.equal(
    wallClockToInstant("2026-09-14T10:00", "Asia/Riyadh"),
    "2026-09-14T07:00:00.000Z",
  );
  assert.equal(instantToWallClock("2026-09-14T07:00:00.000Z", "Asia/Riyadh"), "2026-09-14T10:00");
  assert.equal(formatInZone("2026-09-14T07:00:00.000Z", "Asia/Riyadh"), "2026-09-14 10:00");
  assert.equal(formatUtc("2026-09-14T07:00:00.000Z"), "2026-09-14 07:00 UTC");

  // The defect this replaced: an edit form pre-filled and saved back must not
  // move the visit. Round-trip it many times in zones either side of UTC.
  for (const zone of ["Asia/Riyadh", "America/New_York", "Asia/Kolkata", "UTC"]) {
    let instant = "2026-03-20T09:30:00.000Z";
    for (let i = 0; i < 5; i++)
      instant = wallClockToInstant(instantToWallClock(instant, zone), zone)!;
    assert.equal(instant, "2026-03-20T09:30:00.000Z", zone);
  }

  // Offsets that change: New York summer and winter.
  assert.equal(wallClockToInstant("2026-07-01T09:00", "America/New_York"), "2026-07-01T13:00:00.000Z");
  assert.equal(wallClockToInstant("2026-12-01T09:00", "America/New_York"), "2026-12-01T14:00:00.000Z");
  // A repeated hour resolves to its first occurrence (EDT, -4).
  assert.equal(wallClockToInstant("2026-11-01T01:30", "America/New_York"), "2026-11-01T05:30:00.000Z");
  // A skipped hour still yields a real instant next to the gap.
  const gap = wallClockToInstant("2026-03-08T02:30", "America/New_York")!;
  assert.ok(["2026-03-08T06:30:00.000Z", "2026-03-08T07:30:00.000Z"].includes(gap), gap);

  // Malformed input is refused rather than guessed.
  assert.equal(wallClockToInstant("2026-02-30T10:00", "Asia/Riyadh"), null);
  assert.equal(wallClockToInstant("14/09/2026 10:00", "Asia/Riyadh"), null);
  assert.equal(wallClockToInstant("2026-09-14T10:00", "Not/AZone"), null);
  assert.equal(formatInZone(null, "Asia/Riyadh"), "");
});

test("L-4 every catalog touched by this phase is complete in both languages", () => {
  const same = (a: object, b: object, name: string) =>
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), name);
  same(staffAr, staffEn, "staff");
  same(respondentAr, respondentEn, "respondent");
  same(campaignMessages("ar"), campaignMessages("en"), "campaigns");
  same(visitMessages("ar"), visitMessages("en"), "visits");
  // Post-Audit Repair Pass 1: administration screens, with a label for every
  // audit action the server accepts.
  same(adminMessages("ar"), adminMessages("en"), "administration");
  // Post-Audit Repair Pass 2: request, unsaved-change and background-state
  // wording, with the same placeholders in both languages.
  same(resultsMessages("ar"), resultsMessages("en"), "results");
  const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
  for (const [a, b] of [
    [staffAr, staffEn],
    [resultsMessages("ar"), resultsMessages("en")],
    [visitMessages("ar"), visitMessages("en")],
    [campaignMessages("ar"), campaignMessages("en")],
  ] as Record<string, string>[][])
    for (const key of Object.keys(a)) assert.equal(holes(a[key]), holes(b[key]), key);
  for (const action of AUDIT_ACTIONS)
    for (const locale of ["ar", "en"] as const)
      assert.ok(adminMessages(locale)[`a_${action}`], `${locale} a_${action}`);
  for (const [key, value] of Object.entries(adminMessages("en"))) assert.ok(value.length > 0, key);
  // No empty string, and no Arabic letters inside the English respondent catalog
  // except the language switch, which names Arabic in Arabic on purpose.
  for (const [key, value] of Object.entries(respondentEn)) {
    assert.ok(value.length > 0, key);
    if (key !== "language") assert.doesNotMatch(value, /[؀-ۿ]/, key);
  }
  for (const [key, value] of Object.entries(respondentAr)) assert.ok(value.length > 0, key);
  // Placeholders survive in both catalogs and are filled as text.
  for (const key of Object.keys(respondentAr) as (keyof typeof respondentAr)[]) {
    const names = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    assert.equal(names(respondentAr[key]), names(respondentEn[key]), key);
  }
  assert.equal(fill(respondentEn.numberRange, { min: "0", max: "<b>" }), "A value from 0 to <b>.");
});
