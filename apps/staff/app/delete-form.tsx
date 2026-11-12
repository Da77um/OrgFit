"use client";
import { useState } from "react";
import { RequestFailure, type AttemptLedger } from "./staff-request";
import { ChangeProblem, silent, type ChangeFailure } from "./request-ui";
import { directoryMessages } from "../../../src/directory-i18n";
import type { Locale } from "../../../src/i18n";

type Messages = ReturnType<typeof directoryMessages>;

/** The words for a deletion refusal code (027): `q_` questionnaire, `o_` organization. */
export function deleteBlockerText(m: Messages, prefix: "q" | "o", code: string | null | undefined) {
  if (!code) return "";
  return (m as Record<string, string>)[`${prefix}_${code}`] ?? m.deleteRefused;
}

// The one deletion confirmation (D-187, D-188), shared by the questionnaire
// library and the organization overview. Deleting cannot be undone, so the
// button stays disabled until the exact title or code is typed. No reason is
// asked for or stored. The change goes through the caller's ledger scope; a
// lost answer is offered as the exact retry, and a refusal names its reason.
export function DeleteForm({
  locale,
  ledger,
  scope,
  expected,
  prefix,
  title,
  help,
  testId,
  submit,
  onCancel,
  onCheck,
}: {
  locale: Locale;
  ledger: AttemptLedger;
  scope: string;
  /** The text to type: the questionnaire's title or the organization's code. */
  expected: string;
  prefix: "q" | "o";
  title: string;
  help: string;
  testId?: string;
  /** Send the deletion; `again` re-sends the scope's unconfirmed attempt. Throws on failure. */
  submit: (again: boolean) => Promise<void>;
  onCancel: () => void;
  onCheck?: () => void;
}) {
  const m = directoryMessages(locale);
  const [typed, setTyped] = useState(""),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState<ChangeFailure | null>(null);
  const matches = typed.trim() === expected.trim() && expected.trim() !== "";
  const run = async (again: boolean) => {
    setBusy(true);
    setProblem(null);
    try {
      await submit(again);
    } catch (e) {
      if (silent(e)) return;
      const reason =
        e instanceof RequestFailure && typeof e.body?.reason === "string" ? e.body.reason : null;
      setProblem({
        failure: reason
          ? new RequestFailure(
              `${m.deleteUnavailable} ${deleteBlockerText(m, prefix, reason)}`,
              "REJECTED",
              { status: 409, code: "STATE_CONFLICT", body: (e as RequestFailure).body },
            )
          : e,
        scope,
        retry: () => void run(true),
      });
    } finally {
      setBusy(false);
    }
  };
  const inputId = `${testId ?? "delete"}-confirm`;
  return (
    <form
      className="panel stack"
      data-testid={testId}
      onSubmit={(e) => {
        e.preventDefault();
        if (matches) void run(false);
      }}
    >
      <h3>{title}</h3>
      <p>{help}</p>
      <p>
        <strong>{m.deleteCannotUndo}</strong>
      </p>
      <ChangeProblem
        locale={locale}
        problem={problem}
        ledger={ledger}
        busy={busy}
        onCheck={onCheck}
        onDismiss={() => setProblem(null)}
      />
      <label htmlFor={inputId}>
        {m.deleteTypeToConfirm.replace("{value}", "")}
        <bdi className="num">{expected}</bdi>
      </label>
      <input
        id={inputId}
        name="confirm"
        autoComplete="off"
        dir="auto"
        value={typed}
        aria-describedby={`${inputId}-hint`}
        onChange={(e) => setTyped(e.target.value)}
      />
      <span id={`${inputId}-hint`} className="field-hint">
        {m.deleteMismatch}
      </span>
      <div className="row">
        <button className="button-danger" disabled={busy || !matches}>
          {title}
        </button>
        <button type="button" onClick={onCancel}>
          {m.cancel}
        </button>
      </div>
    </form>
  );
}
