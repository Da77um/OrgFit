"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Instrument, Question } from "../../../src/instrument-input";
import { fill, respondentMessages } from "../../../src/respondent-i18n";
import { direction, type Locale } from "../../../src/i18n";
import {
  checkAnswer,
  isMissing,
  normalizeNumerals,
  type AnswerIssue,
} from "../../../src/answer-rules";
import { Alert, Label, LoadingState, Mark } from "../../../src/ui";
import {
  CIPHER_VERSION,
  decryptDraft,
  encryptDraft,
  encodeResumeCode,
  importDraftKey,
  newDraftKeyBytes,
  newHandle,
  parseResumeCode,
  toBase64,
  fromBase64,
  type DraftPlaintext,
} from "../../../src/draft-format";

// The respondent client.
//
// Privacy-relevant properties of this file, all of them deliberate:
//  * the invitation token is read from the URL fragment and removed with
//    history.replaceState before anything else happens, so it never reaches a
//    server log, a Referer header or the back-button history entry;
//  * the draft key is generated here with crypto.getRandomValues and is never
//    put in a request body, a query string or an error report;
//  * there is no analytics, no session replay and no third-party script. The
//    only network calls are to this origin's own /public/v1 endpoints.
//
// Journey properties added in Phase 13, also deliberate:
//  * every status is the truth about the server. A change is "saved" only once
//    a durable write was acknowledged; a submission whose response was lost is
//    "not confirmed", never "failed" and never "received";
//  * an ended session, a campaign that closed mid-answer and a draft saved from
//    another tab are three different facts with three different sentences, and
//    none of them is smoothed over by retrying with weaker checks;
//  * the browser's Back button moves between sections instead of leaving the
//    questionnaire, and the history entries it walks carry no token, answer or
//    identifier — only a section index;
//  * a numeric answer may be typed in Arabic-Indic or Latin digits and is sent
//    in canonical Latin digits; switching language never touches the answers.

type Access =
  | "OPEN"
  | "NOT_YET_OPEN"
  | "CLOSED"
  | "ACCEPTED"
  | "SESSION_EXPIRED"
  | "RATE_LIMITED"
  | "UNAVAILABLE";
type Answers = Record<string, string | string[]>;
type Stage = "loading" | "welcome" | "form" | "review" | "accepted" | "blocked";
type SaveState =
  | "idle"
  | "dirty"
  | "saving"
  | "saved"
  | "failed"
  | "conflict"
  | "exists"
  | "limited";
type DraftState = { handle: string; key: CryptoKey; raw: Uint8Array; revision: number };
type Messages = ReturnType<typeof respondentMessages>;

const LOCAL_KEY = "orgfit.survey.draft";
// A request that has not answered in this long is reported as not saved. The
// server may still complete it; the revision check makes that harmless.
const REQUEST_TIMEOUT_MS = 20_000;
// The gateway session's idle window is 30 minutes. A respondent reading and
// answering without saving renews it at most this often.
const KEEPALIVE_MS = 5 * 60_000;
const HISTORY_MARK = "orgfit-survey";

// Read the invitation token from the URL fragment once, and remove it from the
// address bar and the history entry immediately. Subsequent callers get the same
// captured value, so a second mount cannot turn a valid link into "no token".
let capturedToken: string | null | undefined;
function takeFragmentToken() {
  if (capturedToken === undefined) {
    const fragment = window.location.hash.replace(/^#/, "");
    capturedToken = /^[A-Za-z0-9_-]{43}$/.test(fragment) ? fragment : null;
    if (capturedToken)
      window.history.replaceState(null, "", window.location.pathname);
  }
  return capturedToken;
}

// NETWORK means no HTTP answer arrived at all: offline, refused, or timed out.
// It is kept apart from every server code because it says nothing about
// whether the server acted.
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`/public/v1/${path}`, {
      ...init,
      signal: controller.signal,
      credentials: "same-origin",
      cache: "no-store",
      headers: init?.body ? { "content-type": "application/json" } : undefined,
    });
  } catch {
    throw new Error("NETWORK");
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.code ?? "TEMPORARILY_UNAVAILABLE");
  return body?.data as T;
}

function readLocaleCookie(): Locale | null {
  try {
    const match = document.cookie.match(/(?:^|;\s*)orgfit-survey-locale=(ar|en)/);
    return (match?.[1] as Locale | undefined) ?? null;
  } catch {
    return null;
  }
}

// Every answerable id in document order: a plain question's own id, or each
// row of a matrix. Content blocks have none and never count toward progress.
function answerSlots(document: Instrument | null) {
  const slots: { id: string; q: Question; section: number }[] = [];
  document?.sections.forEach((s, section) => {
    for (const q of s.questions) {
      if (q.type === "CONTENT") continue;
      if (q.type === "MATRIX")
        for (const r of q.rows) slots.push({ id: r.id, q, section });
      else slots.push({ id: q.id, q, section });
    }
  });
  return slots;
}

export default function Survey() {
  const [locale, setLocale] = useState<Locale>("ar");
  const m = respondentMessages(locale);
  const [stage, setStage] = useState<Stage>("loading");
  const [access, setAccess] = useState<Access>("OPEN");
  const [closedWhileEditing, setClosedWhileEditing] = useState(false);
  const [document_, setDocument] = useState<Instrument | null>(null);
  const [versionId, setVersionId] = useState<string>("");
  const [notice, setNotice] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<Answers>({});
  const [sectionIndex, setSectionIndex] = useState(0);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [save, setSave] = useState<SaveState>("idle");
  const [offline, setOffline] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [resumeCode, setResumeCode] = useState<string | null>(null);
  const [showResume, setShowResume] = useState(false);
  const [resumeInput, setResumeInput] = useState("");
  const [resumeError, setResumeError] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Whether blank required questions and broken rules are shown beside their
  // fields. Off until the respondent tries to move on, so a form does not open
  // covered in errors for questions nobody has reached.
  const [showIssues, setShowIssues] = useState(false);
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [serverInvalid, setServerInvalid] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasStoredDraft, setHasStoredDraft] = useState(false);
  // A required question left blank may be in a section that is not on screen,
  // so the review's "go to this question" has to move the section AND then put
  // the caret on the control. The id is remembered until the field exists.
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const lastRenewal = useRef(0);
  // One bootstrap per page load. A second mount must not exchange again.
  const bootstrapped = useRef(false);

  const dir = direction(locale);
  const text = useCallback(
    (value: { ar: string; en: string } | undefined) =>
      value ? (locale === "en" && value.en ? value.en : value.ar) : "",
    [locale],
  );

  // ---- session bootstrap -------------------------------------------------
  // Runs exactly once per page load. The ref guard matters beyond tidiness: a
  // development double-mount would otherwise exchange the invitation twice, and
  // an effect-cleanup "cancelled" flag would discard the first run's result and
  // leave the page stuck on the loading state.
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    const saved = readLocaleCookie();
    if (saved) setLocale(saved);
    setOffline(!navigator.onLine);
    void (async () => {
      const token = takeFragmentToken();
      try {
        const context = token
          ? await api<{ access: Access }>("invitations/exchange", {
              method: "POST",
              body: JSON.stringify({ token }),
            })
          : await api<{ access: Access }>("status");
        lastRenewal.current = Date.now();
        setAccess(context.access);
        if (context.access !== "OPEN") {
          setStage(context.access === "ACCEPTED" ? "accepted" : "blocked");
          return;
        }
        const payload = await api<{
          versionId: string;
          locales: string[];
          notice: Record<string, string>;
          document: Instrument;
        }>("instrument");
        setDocument(payload.document);
        setVersionId(payload.versionId);
        setNotice(payload.notice ?? {});
        try {
          setHasStoredDraft(!!window.localStorage.getItem(LOCAL_KEY));
        } catch {
          setHasStoredDraft(false);
        }
        // The welcome screen is the base history entry every section sits on.
        window.history.replaceState({ [HISTORY_MARK]: "welcome" }, "");
        setStage("welcome");
      } catch (e) {
        // "Your session ended, open the original link again" is only truthful
        // when the visitor actually arrived with a link. Someone opening the
        // bare survey origin gets the generic unavailable message instead, and
        // learns nothing about whether any questionnaire exists.
        const code = (e as Error).message;
        const expired = code === "SESSION_REQUIRED" && token !== null;
        // A limit says "wait", not "this link is invalid": the invitation is
        // untouched, and reopening the link a minute later works.
        setAccess(expired ? "SESSION_EXPIRED" : code === "RATE_LIMITED" ? "RATE_LIMITED" : "UNAVAILABLE");
        setStage("blocked");
      }
    })();
  }, []);

  // ---- connection ----------------------------------------------------------
  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // ---- leaving with unsaved changes -----------------------------------------
  // The browser shows its own generic prompt; the page cannot and does not
  // decide for the respondent.
  const unsaved =
    (stage === "form" || stage === "review") &&
    (save === "dirty" ||
      save === "failed" ||
      save === "conflict" ||
      save === "exists" ||
      save === "limited");
  useEffect(() => {
    if (!unsaved) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = m.leaveUnsaved;
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [unsaved, m.leaveUnsaved]);

  // ---- history -------------------------------------------------------------
  // Each move to another section or to the review pushes an entry holding only
  // a stage name and a section index. Back therefore walks the questionnaire.
  // Once the questionnaire is finished or blocked, Back no longer reopens it.
  const navigate = useCallback((next: Stage, section: number) => {
    window.history.pushState({ [HISTORY_MARK]: next, section }, "");
    setStage(next);
    setSectionIndex(section);
  }, []);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  useEffect(() => {
    const pop = (event: PopStateEvent) => {
      const current = stageRef.current;
      if (current === "accepted" || current === "blocked" || current === "loading")
        return;
      const state = event.state as Record<string, unknown> | null;
      const target = state?.[HISTORY_MARK];
      if (target === "form" || target === "review") {
        setStage(target);
        setSectionIndex(Number(state?.section) || 0);
      } else {
        setStage("welcome");
      }
      setConfirming(false);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  // ---- reading position ------------------------------------------------------
  // A new section or screen starts at its heading: the page scrolls to the top
  // and focus moves to the heading so a screen reader announces where the
  // respondent now is. A jump to a specific question is the exception — that
  // question's control takes focus instead.
  const previousView = useRef<string>("");
  useEffect(() => {
    const view = `${stage}:${sectionIndex}`;
    const before = previousView.current;
    previousView.current = view;
    if (!before || before.startsWith("loading") || stage === "loading") return;
    if (before === view || pendingFocus) return;
    window.scrollTo(0, 0);
    headingRef.current?.focus({ preventScroll: true });
    // pendingFocus is read, not tracked: clearing it must not move focus again.
  }, [stage, sectionIndex]);

  // ---- document language -----------------------------------------------------
  const changeLocale = useCallback((next: Locale) => {
    setLocale(next);
    // A presentation preference only. It carries no identity, and a refusal
    // costs nothing but remembering the choice on the next visit.
    void api("locale", {
      method: "POST",
      body: JSON.stringify({ locale: next }),
    }).catch(() => undefined);
  }, []);

  // ---- server facts that end the form ---------------------------------------
  // Shared by save, keep-alive and submission. Returns true when the code was
  // one of the facts that change what the page may do.
  const handleTerminal = useCallback((code: string) => {
    if (code === "ALREADY_ACCEPTED") {
      clearLocal();
      setAccess("ACCEPTED");
      setStage("accepted");
      setConfirming(false);
      return true;
    }
    if (code === "COLLECTION_UNAVAILABLE") {
      setAccess("CLOSED");
      setClosedWhileEditing(true);
      setStage("blocked");
      setConfirming(false);
      return true;
    }
    if (code === "SESSION_REQUIRED") {
      setSessionEnded(true);
      setConfirming(false);
      return true;
    }
    return false;
  }, []);

  // Renew the gateway session's idle window while the respondent is working.
  const keepAlive = useCallback(() => {
    if (Date.now() - lastRenewal.current < KEEPALIVE_MS || !navigator.onLine)
      return;
    lastRenewal.current = Date.now();
    void api("session/refresh", { method: "POST", body: "{}" }).catch(
      (e: Error) => {
        handleTerminal(e.message);
      },
    );
  }, [handleTerminal]);

  // ---- draft helpers -----------------------------------------------------
  const persistLocal = (handle: string, raw: Uint8Array, revision: number) => {
    try {
      window.localStorage.setItem(
        LOCAL_KEY,
        JSON.stringify({ handle, key: toBase64(raw), revision }),
      );
    } catch {
      /* A browser refusing storage only costs same-device convenience. */
    }
  };

  const openDraft = useCallback(
    async (handle: string, raw: Uint8Array) => {
      const cipher = await api<{
        handle: string;
        nonce: string;
        ciphertext: string;
        revision: number;
      }>("resume", { method: "POST", body: JSON.stringify({ handle }) });
      const key = await importDraftKey(raw);
      const plain = await decryptDraft(
        key,
        cipher.handle,
        versionId,
        cipher.revision,
        cipher.nonce,
        cipher.ciphertext,
      );
      lastRenewal.current = Date.now();
      setAnswers(plain.answers);
      setDraft({ handle, key, raw, revision: cipher.revision });
      setResumeCode(encodeResumeCode(handle, raw));
      persistLocal(handle, raw, cipher.revision);
      setSave("saved");
      setSessionEnded(false);
      if (stageRef.current === "welcome") navigate("form", 0);
    },
    [versionId, navigate],
  );

  const saveDraft = useCallback(async () => {
    if (!document_) return;
    setSave("saving");
    try {
      const plaintext: DraftPlaintext = {
        schemaVersion: 1,
        versionId,
        answers: answersRef.current,
        locale,
      };
      if (!draft) {
        const raw = newDraftKeyBytes();
        const handle = newHandle();
        const key = await importDraftKey(raw);
        const sealed = await encryptDraft(key, handle, 1, plaintext);
        const result = await api<{ revision: number }>("draft", {
          method: "POST",
          body: JSON.stringify({
            handle,
            cipherVersion: CIPHER_VERSION,
            ...sealed,
            expectedRevision: 0,
          }),
        });
        setDraft({ handle, key, raw, revision: result.revision });
        setResumeCode(encodeResumeCode(handle, raw));
        persistLocal(handle, raw, result.revision);
      } else {
        const next = draft.revision + 1;
        const sealed = await encryptDraft(draft.key, draft.handle, next, plaintext);
        const result = await api<{ revision: number }>("draft", {
          method: "PUT",
          body: JSON.stringify({
            handle: draft.handle,
            cipherVersion: CIPHER_VERSION,
            ...sealed,
            expectedRevision: draft.revision,
          }),
        });
        setDraft({ ...draft, revision: result.revision });
        persistLocal(draft.handle, draft.raw, result.revision);
      }
      lastRenewal.current = Date.now();
      // "Saved" is shown only after the server acknowledged a durable write.
      setSave("saved");
    } catch (e) {
      const code = (e as Error).message;
      if (handleTerminal(code)) {
        setSave("failed");
        return;
      }
      setSave(
        code === "DRAFT_CONFLICT"
          ? "conflict"
          : code === "DRAFT_EXISTS"
            ? "exists"
            : code === "RATE_LIMITED"
              ? "limited"
              : "failed",
      );
    }
  }, [document_, draft, locale, versionId, handleTerminal]);

  // Load the newest saved version: this tab's own draft, or — when another tab
  // or device created one first — the draft this browser holds the key for.
  const reloadDraft = useCallback(async () => {
    try {
      if (draft) return await openDraft(draft.handle, draft.raw);
      const stored = JSON.parse(window.localStorage.getItem(LOCAL_KEY) ?? "null");
      if (!stored?.handle || !stored?.key) throw new Error("none");
      await openDraft(stored.handle, fromBase64(stored.key));
    } catch (e) {
      if (!handleTerminal((e as Error).message)) {
        setSave("failed");
        setShowResume(true);
      }
    }
  }, [draft, openDraft, handleTerminal]);

  const startOver = useCallback(async () => {
    try {
      await api("draft/start-over", {
        method: "POST",
        body: JSON.stringify({ confirmDiscard: true }),
      });
    } catch (e) {
      // Discarding locally while the server copy survives would be a lie about
      // what was deleted, so a refusal leaves everything as it was.
      if (!handleTerminal((e as Error).message)) setSave("failed");
      return;
    }
    clearLocal();
    setHasStoredDraft(false);
    setDraft(null);
    setResumeCode(null);
    setAnswers({});
    setTouched(new Set());
    setShowIssues(false);
    setSave("idle");
    navigate("form", 0);
  }, [handleTerminal, navigate]);

  const resumeSameDevice = useCallback(async () => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(LOCAL_KEY) ?? "null");
      if (!stored?.handle || !stored?.key) throw new Error("none");
      await openDraft(stored.handle, fromBase64(stored.key));
    } catch (e) {
      if (handleTerminal((e as Error).message)) return;
      setResumeError(true);
      setShowResume(true);
    }
  }, [openDraft, handleTerminal]);

  const resumeWithCode = useCallback(async () => {
    const parsed = parseResumeCode(resumeInput);
    if (!parsed) {
      setResumeError(true);
      return;
    }
    try {
      await openDraft(parsed.handle, parsed.key);
      setShowResume(false);
      setResumeError(false);
    } catch (e) {
      if (handleTerminal((e as Error).message)) return;
      // A wrong code, a foreign handle and an expired draft are all reported
      // the same way; nothing about another draft is disclosed.
      setResumeError(true);
    }
  }, [openDraft, resumeInput, handleTerminal]);

  // ---- answering ---------------------------------------------------------
  const setAnswer = (id: string, value: string | string[]) => {
    setAnswers((prev) => ({ ...prev, [id]: value }));
    setServerInvalid((prev) => prev.filter((x) => x !== id));
    setSave((prev) => (prev === "conflict" || prev === "exists" ? prev : "dirty"));
    keepAlive();
  };
  const touch = (id: string) =>
    setTouched((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));

  const slots = useMemo(() => answerSlots(document_), [document_]);
  const requiredIds = useMemo(
    () => slots.filter((s) => s.q.required).map((s) => s.id),
    [slots],
  );
  const unanswered = requiredIds.filter((id) => isMissing(answers[id]));
  // Present answers that break their question's rule, keyed by answer id.
  const issues = useMemo(() => {
    const out: Record<string, AnswerIssue> = {};
    for (const { id, q } of slots) {
      const v = answers[id];
      if (isMissing(v)) continue;
      const checked = checkAnswer(q, v);
      if (!checked.ok) out[id] = checked.issue;
    }
    for (const id of serverInvalid) out[id] ??= "INVALID";
    return out;
  }, [slots, answers, serverInvalid]);
  const invalidIds = slots.map((s) => s.id).filter((id) => issues[id]);

  // Canonical values at the boundary: Latin digits for every numeric answer.
  const canonical = useCallback(() => {
    const out: Answers = {};
    for (const [id, v] of Object.entries(answersRef.current)) {
      const slot = slots.find((s) => s.id === id);
      out[id] =
        typeof v === "string" &&
        slot &&
        ["NUMBER", "RATING_5", "RATING_10"].includes(slot.q.type)
          ? normalizeNumerals(v)
          : v;
    }
    return out;
  }, [slots]);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await api<{ access: string }>("finalize", {
        method: "POST",
        body: JSON.stringify({ answers: canonical() }),
      });
      if (result.access === "ACCEPTED") {
        clearLocal();
        setConfirming(false);
        setStage("accepted");
        setAccess("ACCEPTED");
      }
    } catch (e) {
      const code = (e as Error).message;
      // A retry after a lost success response is not an error: the first
      // acceptance stands and nothing is overwritten.
      if (handleTerminal(code)) return;
      setConfirming(false);
      if (code === "VALIDATION_FAILED") {
        setShowIssues(true);
        setError(m.invalidAnswers);
        // The server names the first answer it refused. Ask it, so the field is
        // marked even where this page's own checks found nothing.
        try {
          const verdict = await api<{ fieldErrors: { path: string }[] }>(
            "review",
            { method: "POST", body: JSON.stringify({ answers: canonical() }) },
          );
          setServerInvalid(
            verdict.fieldErrors
              .map((f) => f.path)
              // A blank required answer is already listed as missing; only a
              // present answer can be one the server refused as invalid.
              .filter(
                (p) =>
                  slots.some((s) => s.id === p) &&
                  !isMissing(answersRef.current[p]),
              ),
          );
        } catch {
          /* the generic message already stands */
        }
      } else if (code === "RATE_LIMITED") {
        setError(m.rateLimited);
      } else if (code === "NETWORK") {
        // No answer arrived. The submission may or may not have been accepted,
        // and saying either would be a guess.
        setError(m.submitUncertain);
      } else {
        setError(m.serviceUnavailable);
      }
    } finally {
      setSubmitting(false);
    }
  }, [m, canonical, handleTerminal, slots]);

  const sectionOfAnswer = (id: string) =>
    slots.find((s) => s.id === id)?.section ?? 0;
  const jumpTo = (id: string) => {
    setPendingFocus(id);
    navigate("form", sectionOfAnswer(id));
  };

  const sectionBlocked = (index: number) =>
    slots.some(
      (s) =>
        s.section === index &&
        (issues[s.id] !== undefined),
    );

  // ---- rendering ---------------------------------------------------------
  if (stage === "loading")
    return (
      <main id="main" className="wrap">
        <LoadingState label={m.loading} />
      </main>
    );

  if (stage === "blocked" || stage === "accepted") {
    const message =
      stage === "accepted"
        ? null
        : access === "NOT_YET_OPEN"
          ? m.notYetOpen
          : access === "CLOSED"
            ? closedWhileEditing
              ? m.closedWhileEditing
              : m.closed
            : access === "SESSION_EXPIRED"
              ? m.sessionExpired
              : access === "RATE_LIMITED"
                ? m.rateLimited
                : m.unavailable;
    // A closed campaign, a link that was never valid and an expired session
    // are three different facts. None of them is an error the visitor caused,
    // and none of them may hint at whether a questionnaire exists.
    return (
      <Shell locale={locale} setLocale={changeLocale} dir={dir}>
        <section className="panel login stack">
          <Mark className="state-mark" />
          <h1 ref={headingRef} tabIndex={-1}>
            {stage === "accepted" ? m.acceptedTitle : m.appTitle}
          </h1>
          {stage === "accepted" ? (
            <Alert tone="success" role="status">
              {m.acceptedBody}
            </Alert>
          ) : (
            <Alert
              tone={access === "NOT_YET_OPEN" ? "info" : "warning"}
              role="status"
            >
              {message}
            </Alert>
          )}
        </section>
      </Shell>
    );
  }

  const section = document_?.sections[sectionIndex];
  const connection = (
    <>
      {offline && (
        <div className="survey-status">
          <Alert tone="warning" role="status">
            {m.offline}
          </Alert>
        </div>
      )}
      {sessionEnded && (
        <div className="survey-status">
          <Alert tone="danger" role="alert">
            <p>
              <strong>{m.sessionEndedTitle}</strong>
            </p>
            <p>{m.sessionEndedBody}</p>
          </Alert>
        </div>
      )}
    </>
  );
  const issueText = (q: Question, issue: AnswerIssue) =>
    issueMessage(m, q, issue);

  return (
    <Shell locale={locale} setLocale={changeLocale} dir={dir}>
      {stage === "welcome" && document_ && (
        <section className="panel login stack">
          <Label accent>
            {m.section} · <span className="num">{document_.sections.length}</span>
          </Label>
          <h1 ref={headingRef} tabIndex={-1}>
            {text(document_.title)}
          </h1>
          <p className="lede">{m.welcomeBody}</p>
          {text(document_.introduction) && <p>{text(document_.introduction)}</p>}
          {connection}

          {/* The privacy notice is the first thing on the screen, not a link
              at the foot of it, and the limits sit inside the same block as
              the promise so neither can be read without the other. */}
          <section className="card card-accent stack">
            <div className="card-head">
              <h2>{m.privacyTitle}</h2>
            </div>
            <p>{text(notice as { ar: string; en: string }) || m.privacyDefault}</p>
            <div className="note">
              <div>
                <p>
                  <strong>{m.privacyLimitsTitle}</strong>
                </p>
                <p>{m.privacyLimits}</p>
                <p className="muted">{m.sharedDevice}</p>
              </div>
            </div>
          </section>

          <div className="survey-actions">
            <button type="button" onClick={() => navigate("form", 0)}>
              {m.begin}
            </button>
            {hasStoredDraft && (
              <button
                type="button"
                className="button-secondary"
                onClick={resumeSameDevice}
              >
                {m.resumeExisting}
              </button>
            )}
            <button
              type="button"
              className="button-quiet"
              aria-expanded={showResume}
              aria-controls="resume-panel"
              onClick={() => setShowResume(true)}
            >
              {m.resumeTitle}
            </button>
          </div>
          {showResume && (
            <ResumePanel
              m={m}
              value={resumeInput}
              onChange={setResumeInput}
              failed={resumeError}
              onSubmit={resumeWithCode}
            />
          )}
        </section>
      )}

      {stage === "form" && document_ && section && (
        <section className="panel survey">
          {/* Progress is a discrete stepper rather than a computed width: an
              inline style would be discarded by this origin's policy, and the
              sections are countable anyway. The same fact is stated in words
              for a screen reader. Content blocks are not questions and are not
              counted. */}
          <div className="survey-progress">
            <div className="row-between row">
              <Label>
                {m.section} <span className="num">{sectionIndex + 1}</span>{" "}
                {m.of} <span className="num">{document_.sections.length}</span>
              </Label>
              <Label>
                {m.answered}{" "}
                <span className="num" data-testid="answered-count">
                  {requiredIds.length - unanswered.length} / {requiredIds.length}
                </span>
              </Label>
            </div>
            <ol
              className="stepper"
              aria-label={`${m.progress}: ${sectionIndex + 1} / ${document_.sections.length}`}
            >
              {document_.sections.map((s, i) => (
                <li
                  key={s.id}
                  className={
                    i < sectionIndex
                      ? "step-done"
                      : i === sectionIndex
                        ? "step-current"
                        : ""
                  }
                />
              ))}
            </ol>
          </div>
          <h1 ref={headingRef} tabIndex={-1}>
            {text(section.title)}
          </h1>
          {text(section.content) && <p>{text(section.content)}</p>}
          {connection}
          <div>
            {section.questions.map((q) => (
              <QuestionField
                key={q.id}
                question={q}
                answers={answers}
                onChange={setAnswer}
                onTouch={touch}
                text={text}
                m={m}
                missing={showIssues ? unanswered : []}
                issueFor={(id) =>
                  issues[id] && (showIssues || touched.has(id))
                    ? issueText(q, issues[id])
                    : null
                }
                focusId={pendingFocus}
                onFocused={() => setPendingFocus(null)}
              />
            ))}
          </div>
          <SaveBar
            m={m}
            save={save}
            offline={offline}
            onSave={saveDraft}
            onReload={reloadDraft}
            onStartOver={startOver}
            resumeCode={resumeCode}
            disabled={sessionEnded}
          />
          {/* Reached when a draft saved elsewhere cannot be loaded from this
              browser: the private code is then the only way to it. */}
          {showResume && (
            <ResumePanel
              m={m}
              value={resumeInput}
              onChange={setResumeInput}
              failed={resumeError}
              onSubmit={resumeWithCode}
            />
          )}
          <div className="survey-actions">
            {sectionIndex > 0 && (
              <button
                type="button"
                className="button-secondary"
                onClick={() => navigate("form", sectionIndex - 1)}
              >
                {m.previous}
              </button>
            )}
            {sectionIndex < document_.sections.length - 1 ? (
              <button
                type="button"
                onClick={() => {
                  // A broken rule on this page is shown, and moving on is still
                  // allowed: the review is where everything must be right.
                  if (sectionBlocked(sectionIndex)) setShowIssues(true);
                  navigate("form", sectionIndex + 1);
                }}
              >
                {m.next}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setShowIssues(true);
                  navigate("review", sectionIndex);
                }}
              >
                {m.reviewTitle}
              </button>
            )}
          </div>
        </section>
      )}

      {stage === "review" && document_ && (
        <section className="panel survey">
          <h1 ref={headingRef} tabIndex={-1}>
            {m.reviewTitle}
          </h1>
          <p className="lede">{m.reviewBody}</p>
          {connection}
          {error && (
            <Alert tone="danger" role="alert">
              {error}
            </Alert>
          )}
          {/* An error summary that can actually be acted on: each entry moves
              to the section holding the question and focuses its control. */}
          {(unanswered.length > 0 || invalidIds.length > 0) && (
            <div className="alert alert-danger stack" role="alert">
              <div>
                {unanswered.length > 0 && (
                  <>
                    <p>
                      <strong>{m.requiredMissing}</strong>
                    </p>
                    <ul>
                      {unanswered.slice(0, 20).map((id) => (
                        <li key={id}>
                          <button
                            type="button"
                            className="button-quiet button-small"
                            onClick={() => jumpTo(id)}
                          >
                            {labelFor(slots, id, text)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {invalidIds.length > 0 && (
                  <>
                    <p>
                      <strong>{m.invalidSummary}</strong>
                    </p>
                    <ul>
                      {invalidIds.slice(0, 20).map((id) => (
                        <li key={id}>
                          <button
                            type="button"
                            className="button-quiet button-small"
                            onClick={() => jumpTo(id)}
                          >
                            {labelFor(slots, id, text)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </div>
          )}
          <dl className="result-facts review-answers">
            {slots.map(({ id, q }) => (
              <div key={id}>
                <dt>{labelFor(slots, id, text)}</dt>
                <dd>
                  <bdi>{displayAnswer(q, answers[id], text, locale) || "—"}</bdi>
                </dd>
              </div>
            ))}
          </dl>
          <div className="survey-actions">
            <button
              type="button"
              className="button-secondary"
              onClick={() => navigate("form", document_.sections.length - 1)}
            >
              {m.previous}
            </button>
            <button
              type="button"
              disabled={
                unanswered.length > 0 ||
                invalidIds.length > 0 ||
                submitting ||
                sessionEnded
              }
              onClick={() => setConfirming(true)}
            >
              {m.submit}
            </button>
          </div>
          {/* The final submission is irreversible, so it is confirmed in a
              dialog that says exactly that. Escape and Cancel close it; nothing
              else does. */}
          {confirming && (
            <Dialog
              titleId="confirmTitle"
              title={m.confirmTitle}
              onCancel={() => !submitting && setConfirming(false)}
            >
              <Alert tone="warning" role="note">
                {m.confirmBody}
              </Alert>
              <div className="modal-actions">
                <button type="button" disabled={submitting} onClick={submit}>
                  {submitting ? m.submitting : m.confirm}
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={submitting}
                  data-autofocus
                  onClick={() => setConfirming(false)}
                >
                  {m.cancel}
                </button>
              </div>
            </Dialog>
          )}
        </section>
      )}
    </Shell>
  );
}

function clearLocal() {
  try {
    window.localStorage.removeItem(LOCAL_KEY);
  } catch {
    /* nothing to do */
  }
}

function issueMessage(m: Messages, q: Question, issue: AnswerIssue) {
  const v = q.validation;
  switch (issue) {
    case "NUMBER_FORMAT":
      return m.issueNumberFormat;
    case "NUMBER_PRECISION":
      return (v.precision ?? 0) === 0
        ? m.wholeNumber
        : `${m.issueNumberPrecision} ${fill(m.decimals, { n: v.precision ?? 0 })}`;
    case "NUMBER_MIN":
      return fill(m.issueNumberMin, { min: v.min ?? "1" });
    case "NUMBER_MAX":
      return fill(m.issueNumberMax, {
        max: v.max ?? (q.type === "RATING_5" ? "5" : "10"),
      });
    case "DATE_FORMAT":
      return m.issueDateFormat;
    case "DATE_MIN":
      return fill(m.issueDateMin, { min: v.minDate ?? "" });
    case "DATE_MAX":
      return fill(m.issueDateMax, { max: v.maxDate ?? "" });
    case "TOO_LONG":
      return fill(m.issueTooLong, {
        max: v.maxLength ?? (q.type === "LONG_TEXT" ? 5000 : 500),
      });
    case "TOO_FEW":
      return fill(m.issueTooFew, { min: v.minSelections ?? 0 });
    case "TOO_MANY":
      return fill(m.issueTooMany, { max: v.maxSelections ?? q.options.length });
    default:
      return m.issueInvalid;
  }
}

// What the field accepts, stated before anyone gets it wrong.
function hintFor(m: Messages, q: Question) {
  const v = q.validation;
  if (q.type === "NUMBER") {
    const range =
      v.min !== undefined && v.max !== undefined
        ? fill(m.numberRange, { min: v.min, max: v.max })
        : v.min !== undefined
          ? fill(m.numberMinOnly, { min: v.min })
          : v.max !== undefined
            ? fill(m.numberMaxOnly, { max: v.max })
            : "";
    const precision =
      (v.precision ?? 0) === 0
        ? m.wholeNumber
        : fill(m.decimals, { n: v.precision ?? 0 });
    return [range, precision, m.numberHint].filter(Boolean).join(" ");
  }
  if (q.type === "CHECKBOXES" && (v.minSelections || v.maxSelections))
    return fill(m.selectionsRange, {
      min: v.minSelections ?? 0,
      max: v.maxSelections ?? q.options.length,
    });
  if (q.type === "DATE" && v.minDate && v.maxDate)
    return fill(m.dateRange, { min: v.minDate, max: v.maxDate });
  return "";
}

export function Shell({
  children,
  locale,
  setLocale,
  dir,
  title,
}: {
  children: React.ReactNode;
  locale: Locale;
  setLocale: (l: Locale) => void;
  dir: "rtl" | "ltr";
  /** The document title; the questionnaire's own when omitted. */
  title?: string;
}) {
  const m = respondentMessages(locale);
  const heading = title ?? m.appTitle;
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
    document.title = heading;
  }, [locale, dir, heading]);
  return (
    <>
      <a className="skip" href="#main">
        {m.skip}
      </a>
      <header className="appbar">
        <div className="appbar-inner">
          <span className="appbar-brand">
            <Mark tone="inverse" className="appbar-mark" />
            <span className="appbar-word" aria-hidden="true">
              ORGFIT
            </span>
            <strong className="visually-hidden">{heading}</strong>
          </span>
          <button
            type="button"
            className="button-small button-on-dark"
            lang={locale === "ar" ? "en" : "ar"}
            onClick={() => setLocale(locale === "ar" ? "en" : "ar")}
            data-testid="locale-toggle"
          >
            {m.language}
          </button>
        </div>
      </header>
      <main id="main" className="wrap">
        {children}
      </main>
    </>
  );
}

// A modal dialog that behaves like one: focus moves in when it opens (to the
// element marked data-autofocus, else the first control), Tab stays inside,
// Escape asks to cancel, and focus returns to where it was when it closes.
export function Dialog({
  titleId,
  title,
  onCancel,
  children,
}: {
  titleId: string;
  title: string;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = box.current;
    const controls = () =>
      Array.from(
        node?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
        ) ?? [],
      );
    (node?.querySelector<HTMLElement>("[data-autofocus]") ?? controls()[0])?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel.current();
        return;
      }
      if (event.key !== "Tab") return;
      const list = controls();
      if (!list.length) return;
      const first = list[0],
        last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div className="scrim">
      <div
        ref={box}
        className="modal stack"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
        </div>
        {children}
      </div>
    </div>
  );
}

function ResumePanel({
  m,
  value,
  onChange,
  failed,
  onSubmit,
}: {
  m: Messages;
  value: string;
  onChange: (v: string) => void;
  failed: boolean;
  onSubmit: () => void;
}) {
  return (
    <form
      id="resume-panel"
      className="card stack spaced"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="card-head">
        <h2>{m.resumeTitle}</h2>
      </div>
      <p className="muted" id="resume-help">
        {m.resumeBody}
      </p>
      <label>
        {m.resumeCodeTitle}
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          dir="ltr"
          translate="no"
          className="code"
          aria-describedby="resume-help"
          aria-invalid={failed || undefined}
          data-testid="resume-code-input"
        />
      </label>
      {failed && (
        <Alert tone="danger" role="alert">
          {m.resumeFailed}
        </Alert>
      )}
      <div className="row">
        <button type="submit">{m.resumeAction}</button>
      </div>
    </form>
  );
}

function SaveBar({
  m,
  save,
  offline,
  onSave,
  onReload,
  onStartOver,
  resumeCode,
  disabled,
}: {
  m: Messages;
  save: SaveState;
  offline: boolean;
  onSave: () => void;
  onReload: () => void;
  onStartOver: () => void;
  resumeCode: string | null;
  disabled: boolean;
}) {
  const [confirmStartOver, setConfirmStartOver] = useState(false);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const codeRef = useRef<HTMLElement | null>(null);
  const label =
    save === "saving"
      ? m.saving
      : save === "saved"
        ? m.saved
        : save === "failed"
          ? offline
            ? m.saveFailedOffline
            : m.saveFailed
          : save === "limited"
            ? m.rateLimited
            : save === "conflict" || save === "exists"
              ? m.conflictTitle
            : save === "dirty"
              ? m.notSaved
              : "";
  const broken =
    save === "failed" || save === "conflict" || save === "exists" || save === "limited";
  const chip =
    save === "saved"
      ? "save-chip save-chip-saved"
      : broken
        ? "save-chip save-chip-failed"
        : save === "dirty"
          ? "save-chip save-chip-dirty"
          : "save-chip";
  const glyph = save === "saved" ? "✓" : broken ? "×" : "•";
  const copyCode = async () => {
    if (!resumeCode) return;
    try {
      if (!navigator.clipboard) throw new Error("unavailable");
      await navigator.clipboard.writeText(resumeCode);
      setCopy("copied");
    } catch {
      // "Copied" would be untrue. Select the code so a manual copy is one
      // gesture away, and say so.
      const node = codeRef.current;
      if (node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setCopy("failed");
    }
  };
  return (
    <div className="stack spaced">
      <div className="row">
        <button
          type="button"
          className="button-secondary"
          onClick={onSave}
          disabled={save === "saving" || disabled}
        >
          {m.saveDraft}
        </button>
        {/* The status is the truth about the server, not an optimistic guess:
            it says "saved" only after a durable write was acknowledged, and it
            carries a glyph so the state is not a colour alone. */}
        <span className={chip}>
          {/* The glyph sits OUTSIDE the live region. A status region should
              announce the sentence and nothing else, and a decorative mark that
              is only hidden from the accessibility tree is still part of the
              region's text. */}
          {label && (
            <span className="badge-glyph" aria-hidden="true">
              {glyph}
            </span>
          )}
          <span data-testid="save-status" role={broken ? "alert" : "status"}>
            {label}
          </span>
        </span>
      </div>
      {(save === "conflict" || save === "exists") && (
        <div className="alert alert-danger stack" role="alert">
          <div>
            <p>{save === "exists" ? m.draftExistsBody : m.conflictBody}</p>
            <button type="button" className="button-small" onClick={onReload}>
              {m.reload}
            </button>
          </div>
        </div>
      )}
      {resumeCode && (
        <div className="card stack">
          <div className="card-head">
            <h2>{m.resumeCodeTitle}</h2>
          </div>
          <p className="muted">{m.resumeCodeBody}</p>
          {/* A mixed-direction secret: isolated left-to-right so an Arabic
              page can never reorder its separators, and never translated. */}
          <code
            ref={codeRef}
            data-testid="resume-code"
            className="resume-code"
            dir="ltr"
            translate="no"
          >
            {resumeCode}
          </code>
          <div className="row">
            <button type="button" onClick={copyCode}>
              {copy === "copied" ? m.resumeCodeCopied : m.resumeCodeCopy}
            </button>
          </div>
          {copy === "failed" && (
            <Alert tone="warning" role="status">
              {m.resumeCodeCopyFailed}
            </Alert>
          )}
          <p className="muted">{m.resumeCodeLost}</p>
        </div>
      )}
      <div className="row">
        <button
          type="button"
          className="button-quiet"
          disabled={disabled}
          onClick={() => setConfirmStartOver(true)}
        >
          {m.startOver}
        </button>
      </div>
      {confirmStartOver && (
        <Dialog
          titleId="startOverTitle"
          title={m.startOverTitle}
          onCancel={() => setConfirmStartOver(false)}
        >
          <Alert tone="warning" role="note">
            {m.startOverBody}
          </Alert>
          <div className="modal-actions">
            <button
              type="button"
              className="button-danger"
              onClick={() => {
                setConfirmStartOver(false);
                onStartOver();
              }}
            >
              {m.startOver}
            </button>
            <button
              type="button"
              className="button-secondary"
              data-autofocus
              onClick={() => setConfirmStartOver(false)}
            >
              {m.cancel}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function labelFor(
  slots: { id: string; q: Question }[],
  id: string,
  text: (v: { ar: string; en: string } | undefined) => string,
) {
  const slot = slots.find((s) => s.id === id);
  if (!slot) return id;
  const row = slot.q.rows.find((r) => r.id === id);
  return row ? `${text(slot.q.prompt)} — ${text(row.label)}` : text(slot.q.prompt);
}
function displayAnswer(
  q: Question,
  value: string | string[] | undefined,
  text: (v: { ar: string; en: string } | undefined) => string,
  locale: Locale,
) {
  if (value === undefined) return "";
  const options = q.type === "MATRIX" ? q.columns : q.options;
  if (Array.isArray(value))
    return value
      .map((v) => text(options.find((o) => o.id === v)?.label))
      .filter(Boolean)
      .join(locale === "en" ? ", " : "، ");
  const option = options.find((o) => o.id === value);
  return option ? text(option.label) : value;
}

// One question, rendered for the device it is being answered on.
//
// The shapes that matter on a phone:
//
//   * a rating scale is a wrapping band of equal targets carrying the numeral,
//     not ten stacked rows — a ten-point scale used to push the next question
//     a full screen down;
//   * a matrix becomes one labelled group per row inside one labelled group for
//     the question, because a horizontally scrolling grid cannot be answered
//     one-handed;
//   * what a field accepts is stated beside it before anyone gets it wrong, and
//     a rule it breaks is stated in words beside it, linked to the control with
//     aria-describedby rather than folded into the control's name.
function QuestionField({
  question,
  answers,
  onChange,
  onTouch,
  text,
  m,
  missing,
  issueFor,
  focusId,
  onFocused,
}: {
  question: Question;
  answers: Answers;
  onChange: (id: string, value: string | string[]) => void;
  onTouch: (id: string) => void;
  text: (v: { ar: string; en: string } | undefined) => string;
  m: Messages;
  missing: string[];
  issueFor: (id: string) => string | null;
  focusId?: string | null;
  onFocused?: () => void;
}) {
  const q = question;
  const holder = useRef<HTMLDivElement | null>(null);
  const ids =
    q.type === "MATRIX"
      ? q.rows.map((r) => r.id)
      : q.type === "CONTENT"
        ? []
        : [q.id];
  const wanted = !!focusId && ids.includes(focusId);
  useEffect(() => {
    if (!wanted || !holder.current) return;
    const scope =
      holder.current.querySelector<HTMLElement>(`[data-slot="${focusId}"]`) ??
      holder.current;
    const control = scope.querySelector<HTMLElement>("input, select, textarea");
    control?.focus({ preventScroll: true });
    scope.scrollIntoView({ block: "center" });
    onFocused?.();
  }, [wanted, focusId, onFocused]);

  if (q.type === "CONTENT")
    return (
      <div className="spaced">
        <h2>{text(q.prompt)}</h2>
        {text(q.help) && <p className="muted">{text(q.help)}</p>}
      </div>
    );

  const badge = q.required ? labels(m).required : labels(m).optional;
  const value = answers[q.id];
  const options = q.options;
  const hint = hintFor(m, q);
  const help = text(q.help);
  // Stable element ids derived from the question id; no answer in them.
  const hintId = `hint-${q.id}`;
  const errorId = (id: string) => `error-${id}`;
  const problem = (id: string) =>
    missing.includes(id) ? m.mustAnswer : issueFor(id);
  const describedBy = (id: string) =>
    [help || hint ? hintId : "", problem(id) ? errorId(id) : ""]
      .filter(Boolean)
      .join(" ") || undefined;

  const promptLine = (
    <>
      <span className="survey-prompt">{text(q.prompt)}</span>
      <span
        className={q.required ? "badge badge-accent" : "badge badge-neutral"}
      >
        <span className="badge-glyph" aria-hidden="true">
          {q.required ? "◆" : "·"}
        </span>
        <span>{badge}</span>
      </span>
    </>
  );
  const notes = (id: string, withHint = true) => (
    <>
      {withHint && (help || hint) && (
        <span className="field-hint" id={hintId}>
          {[help, hint].filter(Boolean).join(" ")}
        </span>
      )}
      {problem(id) && (
        <span className="field-error" id={errorId(id)}>
          {problem(id)}
        </span>
      )}
    </>
  );

  const single = (
    id: string,
    choices: typeof options,
    current: string | undefined,
    legend: React.ReactNode,
    withHint: boolean,
  ) => (
    <fieldset
      className="survey-question"
      data-slot={id}
      data-invalid={problem(id) ? "true" : undefined}
      aria-describedby={withHint ? describedBy(id) : problem(id) ? errorId(id) : undefined}
      onBlur={() => onTouch(id)}
    >
      <legend>{legend}</legend>
      {notes(id, withHint)}
      {choices.map((o) => (
        <label className="choice" key={o.id}>
          <input
            type="radio"
            name={id}
            value={o.id}
            checked={current === o.id}
            onChange={() => onChange(id, o.id)}
          />
          <span>{text(o.label)}</span>
        </label>
      ))}
    </fieldset>
  );

  const body = (() => {
    if (q.type === "MULTIPLE_CHOICE" || q.type === "YES_NO")
      return single(q.id, options, value as string | undefined, promptLine, true);

    if (q.type === "RATING_5" || q.type === "RATING_10") {
      const max = q.type === "RATING_5" ? 5 : 10;
      return (
        <fieldset
          className="survey-question"
          data-slot={q.id}
          data-invalid={problem(q.id) ? "true" : undefined}
          aria-describedby={describedBy(q.id)}
          onBlur={() => onTouch(q.id)}
        >
          <legend>{promptLine}</legend>
          {notes(q.id)}
          <div className="scale">
            {Array.from({ length: max }, (_, i) => String(i + 1)).map((n) => (
              <label className="scale-option" key={n}>
                <input
                  type="radio"
                  name={q.id}
                  value={n}
                  checked={normalizeNumerals(String(value ?? "")) === n}
                  onChange={() => onChange(q.id, n)}
                />
                <span>{n}</span>
              </label>
            ))}
          </div>
          {/* The endpoints are the scale's own numerals. No wording is invented
              for anchors the instrument did not define. */}
          <div className="scale-anchors" aria-hidden="true">
            <span className="num">1</span>
            <span className="num">{max}</span>
          </div>
        </fieldset>
      );
    }

    if (q.type === "CHECKBOXES") {
      const current = Array.isArray(value) ? value : [];
      return (
        <fieldset
          className="survey-question"
          data-slot={q.id}
          data-invalid={problem(q.id) ? "true" : undefined}
          aria-describedby={describedBy(q.id)}
          onBlur={() => onTouch(q.id)}
        >
          <legend>{promptLine}</legend>
          {notes(q.id)}
          {options.map((o) => (
            <label className="choice" key={o.id}>
              <input
                type="checkbox"
                value={o.id}
                checked={current.includes(o.id)}
                onChange={(e) =>
                  onChange(
                    q.id,
                    e.target.checked
                      ? [...current, o.id]
                      : current.filter((x) => x !== o.id),
                  )
                }
              />
              <span>{text(o.label)}</span>
            </label>
          ))}
        </fieldset>
      );
    }

    if (q.type === "MATRIX") {
      const headingId = `prompt-${q.id}`;
      return (
        <section
          className="survey-question"
          role="group"
          aria-labelledby={headingId}
          aria-describedby={help ? hintId : undefined}
        >
          <h2 className="survey-prompt" id={headingId}>
            {text(q.prompt)} <span className="muted">({badge})</span>
          </h2>
          {help && (
            <span className="field-hint" id={hintId}>
              {help}
            </span>
          )}
          <div className="matrix">
            {q.rows.map((row) => (
              <div className="matrix-row" key={row.id}>
                {single(
                  row.id,
                  q.columns,
                  answers[row.id] as string | undefined,
                  <span className="survey-prompt">{text(row.label)}</span>,
                  false,
                )}
              </div>
            ))}
          </div>
        </section>
      );
    }

    const inputId = `field-${q.id}`;
    const common = {
      id: inputId,
      "aria-invalid": problem(q.id) ? true : undefined,
      "aria-describedby": describedBy(q.id),
      onBlur: () => onTouch(q.id),
    };
    const labelled = (control: React.ReactNode) => (
      <div
        className="survey-question"
        data-slot={q.id}
        data-invalid={problem(q.id) ? "true" : undefined}
      >
        <label htmlFor={inputId}>{promptLine}</label>
        {notes(q.id)}
        {control}
      </div>
    );

    if (q.type === "DROPDOWN")
      return labelled(
        <select
          {...common}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(q.id, e.target.value)}
        >
          <option value="">{m.choose}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {text(o.label)}
            </option>
          ))}
        </select>,
      );

    if (q.type === "LONG_TEXT")
      return labelled(
        <textarea
          {...common}
          dir="auto"
          value={(value as string) ?? ""}
          maxLength={q.validation.maxLength ?? 5000}
          onChange={(e) => onChange(q.id, e.target.value)}
        />,
      );

    if (q.type === "NUMBER")
      // A text field, not type="number": a number input refuses Arabic-Indic
      // digits in several browsers and silently empties itself, which would
      // look like an answer the respondent gave being thrown away.
      return labelled(
        <input
          {...common}
          type="text"
          inputMode={(q.validation.precision ?? 0) > 0 ? "decimal" : "numeric"}
          dir="ltr"
          autoComplete="off"
          value={(value as string) ?? ""}
          maxLength={40}
          onChange={(e) => onChange(q.id, e.target.value)}
        />,
      );

    return labelled(
      <input
        {...common}
        type={q.type === "DATE" ? "date" : "text"}
        dir={q.type === "DATE" ? undefined : "auto"}
        value={(value as string) ?? ""}
        maxLength={q.type === "DATE" ? undefined : (q.validation.maxLength ?? 500)}
        min={q.type === "DATE" ? q.validation.minDate : undefined}
        max={q.type === "DATE" ? q.validation.maxDate : undefined}
        onChange={(e) => onChange(q.id, e.target.value)}
      />,
    );
  })();

  return <div ref={holder}>{body}</div>;
}

const labels = (m: Messages) => ({ required: m.required, optional: m.optional });
