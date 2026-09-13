// ---------------------------------------------------------------------------
// Wall-clock time in a record's own timezone.
//
// A campaign and a visit each carry an IANA timezone, and the database stores
// an instant. The browser's <input type="datetime-local"> produces neither: it
// yields a bare wall-clock string, and `new Date(wallClock)` silently reads it
// in the BROWSER's timezone. Staff in one city scheduling for an organization in
// another would store the wrong instant, and pre-filling an edit form with a
// UTC wall-clock and saving it back moved a visit by the browser's offset on
// every save.
//
// These functions convert explicitly in the record's timezone using only Intl,
// which every supported browser and Node ship with full zone data. Canonical
// storage stays a locale-independent ISO instant. Display uses Latin digits,
// 24-hour time and the zone name, in every locale, so a time reads the same to
// two staff members looking at the same record.
//
// A wall-clock time that does not exist in the zone (a spring-forward gap)
// resolves to a real instant beside the gap rather than failing, and a repeated
// time (fall-back) resolves to its first occurrence. Both are covered by tests.
// ---------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isTimeZone(value: string) {
  try {
    formatter(value);
    return true;
  } catch {
    return false;
  }
}

function fields(instant: number, timeZone: string) {
  const out: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(instant)))
    if (p.type !== "literal") out[p.type] = Number(p.value);
  return out as {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  };
}

// The zone's offset from UTC at an instant, in milliseconds.
function offset(instant: number, timeZone: string) {
  const f = fields(instant, timeZone);
  const wall = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return wall - Math.floor(instant / 1000) * 1000;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** "2026-09-14T10:00" read in `timeZone` → ISO instant, or null if malformed. */
export function wallClockToInstant(local: string, timeZone: string) {
  const match = WALL.exec(local);
  if (!match || !isTimeZone(timeZone)) return null;
  const [y, mo, d, h, mi, s] = match.slice(1).map((v) => Number(v ?? 0));
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (Number.isNaN(guess) || new Date(guess).getUTCDate() !== d) return null;
  // Two passes settle both sides of an offset change.
  const first = guess - offset(guess, timeZone);
  const second = guess - offset(first, timeZone);
  return new Date(second).toISOString();
}

/** ISO instant → "2026-09-14T10:00" in `timeZone`, for a datetime-local input. */
export function instantToWallClock(iso: string | null | undefined, timeZone: string) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t) || !isTimeZone(timeZone)) return "";
  const f = fields(t, timeZone);
  return `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}T${pad(f.hour)}:${pad(f.minute)}`;
}

/** ISO instant → "2026-09-14 10:00" in `timeZone`. The caller shows the zone. */
export function formatInZone(iso: string | null | undefined, timeZone: string) {
  return instantToWallClock(iso, timeZone).replace("T", " ");
}

/** The UTC calendar date of an instant, for events with no record timezone.
 *  Slicing the database's timestamp text gives the date in the SERVER's zone
 *  instead, which disagreed with the reports' UTC dates near midnight. */
export function utcDate(iso: string | null | undefined) {
  return formatInZone(iso, "UTC").slice(0, 10);
}

/** An event with no record timezone (a report job, an audit time) is shown in
 *  UTC and says so, rather than in whatever zone the viewing browser is in. */
export function formatUtc(iso: string | null | undefined) {
  const text = formatInZone(iso, "UTC");
  return text ? `${text} UTC` : "";
}
