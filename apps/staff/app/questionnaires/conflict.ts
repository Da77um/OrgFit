import type { Version } from "../../../../src/instruments";
import type { Instrument } from "../../../../src/instrument-input";
import { RequestFailure } from "../staff-request";

// The draft editor's way out of a stale revision. Pure decisions only, so the
// node suite proves them without a browser: the workspace fetches, these say
// what to do with what came back, and none of them ever drops typed edits.

/** The server refused a change because the page holds an older revision (or
 *  the version stopped being a draft). An idempotency-key reuse is not one. */
export const isConflict = (e: unknown) =>
  e instanceof RequestFailure && e.status === 409 && e.code !== "IDEMPOTENCY_CONFLICT";

/** STALE: a newer revision exists. NOT_DRAFT: the version was published or
 *  retired elsewhere, so edits can no longer be saved into it. */
export type Conflict = "STALE" | "NOT_DRAFT";

/** STATE_CONFLICT means the version or its questionnaire stopped being
 *  editable; any other refused 409 is a newer revision. */
export const conflictOf = (e: unknown): Conflict =>
  e instanceof RequestFailure && e.code === "STATE_CONFLICT" ? "NOT_DRAFT" : "STALE";

export type Recovered =
  /** The fresh revision is adopted; the edits stay on the page, unsaved. */
  | { outcome: "KEPT"; version: Version; doc: Instrument; dirty: true }
  /** The page shows the server's document; there were no edits to keep. */
  | { outcome: "LOADED"; version: Version; doc: Instrument; dirty: false }
  /** The edits cannot be kept here; nothing was changed on the page. */
  | { outcome: "NOT_DRAFT" };

/**
 * After "reload the version". With `edits`, keep them on top of the fresh
 * revision so the normal save writes them; without, show the server document.
 * A version that is no longer a draft (or whose questionnaire is no longer
 * active) cannot take the edits, so they are left untouched on the page.
 */
export function recoverConflict(
  fresh: Version,
  edits: Instrument | null,
  active = true,
): Recovered {
  if (!edits) return { outcome: "LOADED", version: fresh, doc: fresh.document, dirty: false };
  if (!active || fresh.state !== "DRAFT") return { outcome: "NOT_DRAFT" };
  return { outcome: "KEPT", version: fresh, doc: edits, dirty: true };
}

/**
 * After an unconfirmed save is set aside. The attempt may have landed, which
 * moved the server one revision ahead of the page. The fresh revision is
 * adopted only when it is provably ours: unchanged, or holding exactly the
 * document that attempt sent. Anything else is someone else's write and is a
 * conflict the user decides, never one resolved silently.
 */
export function afterSetAside(
  attempt: { body?: unknown; revision?: number | string } | undefined,
  fresh: Version,
  edits: Instrument | null,
): Recovered | { outcome: "CONFLICT" } {
  const unchanged = attempt?.revision !== undefined && String(attempt.revision) === String(fresh.revision);
  const landed = attempt?.body !== undefined && JSON.stringify(fresh.document) === JSON.stringify(attempt.body);
  if (edits && !unchanged && !landed) return { outcome: "CONFLICT" };
  return recoverConflict(fresh, edits);
}

/**
 * After a confirmed save. The page takes the server's document only if
 * nothing was typed while the save was in flight; otherwise the newer edits
 * stay and remain dirty, to be saved against the revision just returned.
 */
export function settleSave(sent: Instrument, latest: Instrument, saved: Version) {
  return latest === sent
    ? { doc: saved.document, dirty: false }
    : { doc: latest, dirty: true };
}
