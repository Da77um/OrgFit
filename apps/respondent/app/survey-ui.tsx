"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Instrument, Question } from "../../../src/instrument-input";
import { respondentMessages } from "../../../src/respondent-i18n";
import { direction, type Locale } from "../../../src/i18n";
import {
  Alert,
  Label,
  LoadingState,
  Mark,
} from "../../../src/ui";
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

type Access =
  | "OPEN"
  | "NOT_YET_OPEN"
  | "CLOSED"
  | "ACCEPTED"
  | "SESSION_EXPIRED"
  | "UNAVAILABLE";
type Answers = Record<string, string | string[]>;
type Stage = "loading" | "welcome" | "form" | "review" | "accepted" | "blocked";
type SaveState = "idle" | "dirty" | "saving" | "saved" | "failed" | "conflict";
type DraftState = { handle: string; key: CryptoKey; raw: Uint8Array; revision: number };

const LOCAL_KEY = "orgfit.survey.draft";

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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/public/v1/${path}`, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const error = new Error(body?.code ?? "TEMPORARILY_UNAVAILABLE");
    throw error;
  }
  return body?.data as T;
}

export default function Survey() {
  const [locale, setLocale] = useState<Locale>("ar");
  const m = respondentMessages(locale);
  const [stage, setStage] = useState<Stage>("loading");
  const [access, setAccess] = useState<Access>("OPEN");
  const [document_, setDocument] = useState<Instrument | null>(null);
  const [versionId, setVersionId] = useState<string>("");
  const [notice, setNotice] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<Answers>({});
  const [sectionIndex, setSectionIndex] = useState(0);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [save, setSave] = useState<SaveState>("idle");
  const [resumeCode, setResumeCode] = useState<string | null>(null);
  const [showResume, setShowResume] = useState(false);
  const [resumeInput, setResumeInput] = useState("");
  const [resumeError, setResumeError] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [hasStoredDraft, setHasStoredDraft] = useState(false);
  // A required question left blank may be in a section that is not on screen,
  // so the review's "go to this question" has to move the section AND then put
  // the caret on the control. The id is remembered until the field exists.
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const answersRef = useRef(answers);
  answersRef.current = answers;
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
    void (async () => {
      const token = takeFragmentToken();
      try {
        const context = token
          ? await api<{ access: Access }>("invitations/exchange", {
              method: "POST",
              body: JSON.stringify({ token }),
            })
          : await api<{ access: Access }>("status");
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
        setStage("welcome");
      } catch (e) {
        // "Your session ended, open the original link again" is only truthful
        // when the visitor actually arrived with a link. Someone opening the
        // bare survey origin gets the generic unavailable message instead, and
        // learns nothing about whether any questionnaire exists.
        const expired =
          (e as Error).message === "SESSION_REQUIRED" && token !== null;
        setAccess(expired ? "SESSION_EXPIRED" : "UNAVAILABLE");
        setStage("blocked");
      }
    })();
  }, []);

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
  const clearLocal = () => {
    try {
      window.localStorage.removeItem(LOCAL_KEY);
    } catch {
      /* nothing to do */
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
      setAnswers(plain.answers);
      setDraft({ handle, key, raw, revision: cipher.revision });
      setResumeCode(encodeResumeCode(handle, raw));
      persistLocal(handle, raw, cipher.revision);
      setSave("saved");
      setStage("form");
    },
    [versionId],
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
      // "Saved" is shown only after the server acknowledged a durable write.
      setSave("saved");
    } catch (e) {
      const code = (e as Error).message;
      setSave(code === "DRAFT_CONFLICT" ? "conflict" : "failed");
    }
  }, [document_, draft, locale, versionId]);

  const reloadDraft = useCallback(async () => {
    if (!draft) return;
    try {
      await openDraft(draft.handle, draft.raw);
    } catch {
      setSave("failed");
    }
  }, [draft, openDraft]);

  const startOver = useCallback(async () => {
    await api("draft/start-over", {
      method: "POST",
      body: JSON.stringify({ confirmDiscard: true }),
    }).catch(() => undefined);
    clearLocal();
    setDraft(null);
    setResumeCode(null);
    setAnswers({});
    setSave("idle");
    setSectionIndex(0);
    setStage("form");
  }, []);

  const resumeSameDevice = useCallback(async () => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(LOCAL_KEY) ?? "null");
      if (!stored?.handle || !stored?.key) throw new Error("none");
      await openDraft(stored.handle, fromBase64(stored.key));
    } catch {
      setResumeError(true);
      setShowResume(true);
    }
  }, [openDraft]);

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
    } catch {
      // A wrong code, a foreign handle and an expired draft are all reported
      // the same way; nothing about another draft is disclosed.
      setResumeError(true);
    }
  }, [openDraft, resumeInput]);

  // ---- answering ---------------------------------------------------------
  const setAnswer = (id: string, value: string | string[]) => {
    setAnswers((prev) => ({ ...prev, [id]: value }));
    setSave("dirty");
  };
  const questions = useMemo(
    () => document_?.sections.flatMap((s) => s.questions) ?? [],
    [document_],
  );
  const requiredIds = useMemo(() => {
    const ids: string[] = [];
    for (const q of questions) {
      if (q.type === "CONTENT" || !q.required) continue;
      if (q.type === "MATRIX") ids.push(...q.rows.map((r) => r.id));
      else ids.push(q.id);
    }
    return ids;
  }, [questions]);
  const unanswered = requiredIds.filter((id) => {
    const v = answers[id];
    return v === undefined || (Array.isArray(v) ? v.length === 0 : !v.trim());
  });

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await api<{ access: string }>("finalize", {
        method: "POST",
        body: JSON.stringify({ answers: answersRef.current }),
      });
      if (result.access === "ACCEPTED") {
        clearLocal();
        setStage("accepted");
        setAccess("ACCEPTED");
      }
    } catch (e) {
      const code = (e as Error).message;
      if (code === "ALREADY_ACCEPTED") {
        // A retry after a lost success response is not an error: the first
        // acceptance stands and nothing is overwritten.
        clearLocal();
        setStage("accepted");
        setAccess("ACCEPTED");
      } else if (code === "VALIDATION_FAILED") {
        setMissing(unanswered);
        setError(m.invalidAnswers);
        setConfirming(false);
        setStage("review");
      } else if (code === "COLLECTION_UNAVAILABLE") {
        setAccess("CLOSED");
        setStage("blocked");
      } else {
        setError(m.serviceUnavailable);
        setConfirming(false);
      }
    } finally {
      setSubmitting(false);
    }
  }, [m, unanswered]);

  // Which section holds a given answer id. Built from the pinned document, so
  // it stays correct for a matrix row as well as for a plain question.
  const sectionOfAnswer = (id: string) => {
    const sections = document_?.sections ?? [];
    for (let i = 0; i < sections.length; i++)
      for (const q of sections[i].questions)
        if (q.id === id || q.rows.some((r) => r.id === id)) return i;
    return 0;
  };
  const jumpTo = (id: string) => {
    setSectionIndex(sectionOfAnswer(id));
    setStage("form");
    setPendingFocus(id);
  };

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
            ? m.closed
            : access === "SESSION_EXPIRED"
              ? m.sessionExpired
              : m.unavailable;
    // A closed campaign, a link that was never valid and an expired session
    // are three different facts. None of them is an error the visitor caused,
    // and none of them may hint at whether a questionnaire exists.
    return (
      <Shell locale={locale} setLocale={setLocale} dir={dir}>
        <section className="panel login stack">
          <Mark className="state-mark" />
          <h1>{stage === "accepted" ? m.acceptedTitle : m.appTitle}</h1>
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
  return (
    <Shell locale={locale} setLocale={setLocale} dir={dir}>
      {stage === "welcome" && document_ && (
        <section className="panel login stack">
          <Label accent>
            {m.section} · <span className="num">{document_.sections.length}</span>
          </Label>
          <h1>{text(document_.title)}</h1>
          <p className="lede">{m.welcomeBody}</p>
          {text(document_.introduction) && <p>{text(document_.introduction)}</p>}

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
            <button type="button" onClick={() => setStage("form")}>
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
              onClick={() => setShowResume(true)}
            >
              {m.resumeTitle}
            </button>
          </div>
          {showResume && (
            <div className="card stack spaced">
              <div className="card-head">
                <h2>{m.resumeTitle}</h2>
              </div>
              <p className="muted">{m.resumeBody}</p>
              <label>
                {m.resumeCodeTitle}
                <input
                  value={resumeInput}
                  onChange={(e) => setResumeInput(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  dir="ltr"
                  className="code"
                  aria-invalid={resumeError || undefined}
                  data-testid="resume-code-input"
                />
              </label>
              {resumeError && (
                <Alert tone="danger" role="alert">
                  {m.resumeFailed}
                </Alert>
              )}
              <div className="row">
                <button type="button" onClick={resumeWithCode}>
                  {m.resumeAction}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {stage === "form" && document_ && section && (
        <section className="panel survey">
          {/* Progress is a discrete stepper rather than a computed width: an
              inline style would be discarded by this origin's policy, and the
              sections are countable anyway. The same fact is stated in words
              for a screen reader. */}
          <div className="survey-progress">
            <div className="row-between row">
              <Label>
                {m.section} <span className="num">{sectionIndex + 1}</span>{" "}
                {m.of} <span className="num">{document_.sections.length}</span>
              </Label>
              <Label>
                {m.answered}{" "}
                <span className="num">
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
          <h1>{text(section.title)}</h1>
          {text(section.content) && <p>{text(section.content)}</p>}
          <div>
            {section.questions.map((q) => (
              <QuestionField
                key={q.id}
                question={q}
                answers={answers}
                onChange={setAnswer}
                text={text}
                labels={{
                  required: m.required,
                  optional: m.optional,
                  choose: m.choose,
                  mustAnswer: m.mustAnswer,
                }}
                invalid={missing}
                focusId={pendingFocus}
                onFocused={() => setPendingFocus(null)}
              />
            ))}
          </div>
          <SaveBar
            m={m}
            save={save}
            onSave={saveDraft}
            onReload={reloadDraft}
            onStartOver={startOver}
            resumeCode={resumeCode}
            copied={copied}
            setCopied={setCopied}
          />
          <div className="survey-actions">
            {sectionIndex > 0 && (
              <button
                type="button"
                className="button-secondary"
                onClick={() => setSectionIndex(sectionIndex - 1)}
              >
                {m.previous}
              </button>
            )}
            {sectionIndex < document_.sections.length - 1 ? (
              <button type="button" onClick={() => setSectionIndex(sectionIndex + 1)}>
                {m.next}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setMissing(unanswered);
                  setStage("review");
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
          <h1>{m.reviewTitle}</h1>
          <p className="lede">{m.reviewBody}</p>
          {error && (
            <Alert tone="danger" role="alert">
              {error}
            </Alert>
          )}
          {/* An error summary that can actually be acted on: each entry moves
              to the section holding the question and focuses its control. */}
          {unanswered.length > 0 && (
            <div className="alert alert-danger stack" role="alert">
              <div>
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
                        {labelFor(questions, id, text)}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <dl className="result-facts">
            {questions
              .filter((q) => q.type !== "CONTENT")
              .flatMap((q) =>
                q.type === "MATRIX"
                  ? q.rows.map((r) => ({ id: r.id, q, label: text(r.label) }))
                  : [{ id: q.id, q, label: text(q.prompt) }],
              )
              .map(({ id, q, label }) => (
                <div key={id}>
                  <dt>{label}</dt>
                  <dd>
                    <bdi>{displayAnswer(q, answers[id], text) || "—"}</bdi>
                  </dd>
                </div>
              ))}
          </dl>
          <div className="survey-actions">
            <button
              type="button"
              className="button-secondary"
              onClick={() => setStage("form")}
            >
              {m.previous}
            </button>
            <button
              type="button"
              disabled={unanswered.length > 0 || submitting}
              onClick={() => setConfirming(true)}
            >
              {m.submit}
            </button>
          </div>
          {/* The final submission is irreversible, so it is confirmed in a
              dialog that says exactly that and cannot be dismissed by
              accident. */}
          {confirming && (
            <div className="scrim">
              <div
                className="modal stack"
                role="dialog"
                aria-modal="true"
                aria-labelledby="confirmTitle"
              >
                <div className="modal-head">
                  <h2 id="confirmTitle">{m.confirmTitle}</h2>
                </div>
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
                    onClick={() => setConfirming(false)}
                  >
                    {m.cancel}
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      )}
    </Shell>
  );
}

function Shell({
  children,
  locale,
  setLocale,
  dir,
}: {
  children: React.ReactNode;
  locale: Locale;
  setLocale: (l: Locale) => void;
  dir: "rtl" | "ltr";
}) {
  const m = respondentMessages(locale);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
  }, [locale, dir]);
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
            <strong className="visually-hidden">{m.appTitle}</strong>
          </span>
          <button
            type="button"
            className="button-small"
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

function SaveBar({
  m,
  save,
  onSave,
  onReload,
  onStartOver,
  resumeCode,
  copied,
  setCopied,
}: {
  m: ReturnType<typeof respondentMessages>;
  save: SaveState;
  onSave: () => void;
  onReload: () => void;
  onStartOver: () => void;
  resumeCode: string | null;
  copied: boolean;
  setCopied: (v: boolean) => void;
}) {
  const [confirmStartOver, setConfirmStartOver] = useState(false);
  const label =
    save === "saving"
      ? m.saving
      : save === "saved"
        ? m.saved
        : save === "failed"
          ? m.saveFailed
          : save === "conflict"
            ? m.conflictTitle
            : save === "dirty"
              ? m.notSaved
              : "";
  const chip =
    save === "saved"
      ? "save-chip save-chip-saved"
      : save === "failed" || save === "conflict"
        ? "save-chip save-chip-failed"
        : save === "dirty"
          ? "save-chip save-chip-dirty"
          : "save-chip";
  const glyph =
    save === "saved" ? "✓" : save === "failed" || save === "conflict" ? "×" : "•";
  return (
    <div className="stack spaced">
      <div className="row">
        <button
          type="button"
          className="button-secondary"
          onClick={onSave}
          disabled={save === "saving"}
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
          <span
            data-testid="save-status"
            role={save === "failed" || save === "conflict" ? "alert" : "status"}
          >
            {label}
          </span>
        </span>
      </div>
      {save === "conflict" && (
        <div className="alert alert-danger stack" role="alert">
          <div>
            <p>{m.conflictBody}</p>
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
          <code data-testid="resume-code" className="resume-code">
            {resumeCode}
          </code>
          <div className="row">
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(resumeCode).catch(() => undefined);
                setCopied(true);
              }}
            >
              {copied ? m.resumeCodeCopied : m.resumeCodeCopy}
            </button>
          </div>
          <p className="muted">{m.resumeCodeLost}</p>
        </div>
      )}
      <div className="row">
        <button
          type="button"
          className="button-quiet"
          onClick={() => setConfirmStartOver(true)}
        >
          {m.startOver}
        </button>
      </div>
      {confirmStartOver && (
        <div className="scrim">
          <div
            className="modal stack"
            role="dialog"
            aria-modal="true"
            aria-labelledby="startOverTitle"
          >
            <div className="modal-head">
              <h2 id="startOverTitle">{m.startOverTitle}</h2>
            </div>
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
                onClick={() => setConfirmStartOver(false)}
              >
                {m.cancel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function labelFor(
  questions: Question[],
  id: string,
  text: (v: { ar: string; en: string } | undefined) => string,
) {
  for (const q of questions) {
    if (q.id === id) return text(q.prompt);
    const row = q.rows.find((r) => r.id === id);
    if (row) return `${text(q.prompt)} — ${text(row.label)}`;
  }
  return id;
}
function displayAnswer(
  q: Question,
  value: string | string[] | undefined,
  text: (v: { ar: string; en: string } | undefined) => string,
) {
  if (value === undefined) return "";
  const options = q.type === "MATRIX" ? q.columns : q.options;
  if (Array.isArray(value))
    return value
      .map((v) => text(options.find((o) => o.id === v)?.label))
      .filter(Boolean)
      .join("، ");
  const option = options.find((o) => o.id === value);
  return option ? text(option.label) : value;
}


// One question, rendered for the device it is being answered on.
//
// The three shapes that matter on a phone:
//
//   * a rating scale is a wrapping band of equal targets carrying the numeral,
//     not ten stacked rows — a ten-point scale used to push the next question
//     a full screen down;
//   * a matrix becomes one labelled group per row, because a horizontally
//     scrolling grid cannot be answered one-handed;
//   * a required question left blank says so in words beside itself, not only
//     through aria-invalid, and is reachable from the review's summary.
function QuestionField({
  question,
  answers,
  onChange,
  text,
  labels,
  invalid,
  focusId,
  onFocused,
}: {
  question: Question;
  answers: Answers;
  onChange: (id: string, value: string | string[]) => void;
  text: (v: { ar: string; en: string } | undefined) => string;
  labels: {
    required: string;
    optional: string;
    choose: string;
    mustAnswer: string;
  };
  invalid: string[];
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
    const control = holder.current.querySelector<HTMLElement>(
      "input, select, textarea",
    );
    control?.focus();
    holder.current.scrollIntoView({ block: "center" });
    onFocused?.();
  }, [wanted, onFocused]);

  if (q.type === "CONTENT")
    return (
      <div className="spaced">
        <h2>{text(q.prompt)}</h2>
        {text(q.help) && <p className="muted">{text(q.help)}</p>}
      </div>
    );

  const badge = q.required ? labels.required : labels.optional;
  const value = answers[q.id];
  const options = q.options;
  const prompt = (id: string) => (
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
      {invalid.includes(id) && (
        <span className="field-error">{labels.mustAnswer}</span>
      )}
    </>
  );

  const single = (
    id: string,
    choices: typeof options,
    current: string | undefined,
    legend: React.ReactNode,
  ) => (
    <fieldset
      className="survey-question"
      aria-invalid={invalid.includes(id) || undefined}
    >
      <legend>{legend}</legend>
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
      return single(q.id, options, value as string | undefined, prompt(q.id));

    if (q.type === "RATING_5" || q.type === "RATING_10") {
      const max = q.type === "RATING_5" ? 5 : 10;
      return (
        <fieldset
          className="survey-question"
          aria-invalid={invalid.includes(q.id) || undefined}
        >
          <legend>{prompt(q.id)}</legend>
          <div className="scale">
            {Array.from({ length: max }, (_, i) => String(i + 1)).map((n) => (
              <label className="scale-option" key={n}>
                <input
                  type="radio"
                  name={q.id}
                  value={n}
                  checked={value === n}
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
          aria-invalid={invalid.includes(q.id) || undefined}
        >
          <legend>{prompt(q.id)}</legend>
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

    if (q.type === "MATRIX")
      return (
        <section className="survey-question">
          <h2 className="survey-prompt">
            {text(q.prompt)} <span className="muted">({badge})</span>
          </h2>
          <div className="matrix">
            {q.rows.map((row) => (
              <div className="matrix-row" key={row.id}>
                {single(
                  row.id,
                  q.columns,
                  answers[row.id] as string | undefined,
                  <>
                    <span className="survey-prompt">{text(row.label)}</span>
                    {invalid.includes(row.id) && (
                      <span className="field-error">{labels.mustAnswer}</span>
                    )}
                  </>,
                )}
              </div>
            ))}
          </div>
        </section>
      );

    if (q.type === "DROPDOWN")
      return (
        <div className="survey-question">
          <label>
            <span>{prompt(q.id)}</span>
            <select
              value={(value as string) ?? ""}
              aria-invalid={invalid.includes(q.id) || undefined}
              onChange={(e) => onChange(q.id, e.target.value)}
            >
              <option value="">{labels.choose}</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {text(o.label)}
                </option>
              ))}
            </select>
          </label>
        </div>
      );

    if (q.type === "LONG_TEXT")
      return (
        <div className="survey-question">
          <label>
            <span>{prompt(q.id)}</span>
            <textarea
              value={(value as string) ?? ""}
              maxLength={q.validation.maxLength ?? 5000}
              aria-invalid={invalid.includes(q.id) || undefined}
              onChange={(e) => onChange(q.id, e.target.value)}
            />
          </label>
        </div>
      );

    return (
      <div className="survey-question">
        <label>
          <span>{prompt(q.id)}</span>
          <input
            type={q.type === "DATE" ? "date" : "text"}
            inputMode={q.type === "NUMBER" ? "decimal" : undefined}
            value={(value as string) ?? ""}
            maxLength={q.validation.maxLength ?? 500}
            min={q.type === "DATE" ? q.validation.minDate : undefined}
            max={q.type === "DATE" ? q.validation.maxDate : undefined}
            aria-invalid={invalid.includes(q.id) || undefined}
            onChange={(e) => onChange(q.id, e.target.value)}
          />
        </label>
      </div>
    );
  })();

  return <div ref={holder}>{body}</div>;
}
