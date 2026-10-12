"use client";
import { useState, type ReactNode } from "react";
import type { AttemptLedger } from "./staff-request";
import { ChangeProblem, silent, type ChangeFailure } from "./request-ui";
import { useUnsavedChanges } from "./unsaved";
import { directoryMessages } from "../../../src/directory-i18n";
import type { Locale } from "../../../src/i18n";

// The one archive confirmation, shared by the directory records, the
// organization overview and the questionnaire library. Archiving is never a
// delete: the record stays, with its history. The caller sends the change
// through its own ledger scope; a lost answer is offered as the exact retry.
// A typed reason is kept or discarded by the leave guard, never archived from
// it: archiving is not a save.
export function ArchiveForm({
  locale,
  ledger,
  scope,
  submit,
  onCancel,
  onCheck,
  withReason = true,
  title,
  help,
  confirmLabel,
  testId,
}: {
  locale: Locale;
  ledger: AttemptLedger;
  scope: string;
  /** Send the archive; `again` re-sends the scope's unconfirmed attempt. Throws on failure. */
  submit: (reason: string | null, again: boolean) => Promise<void>;
  onCancel: () => void;
  onCheck?: () => void;
  /** False where the endpoint records no reason (the questionnaire library). */
  withReason?: boolean;
  title?: string;
  help?: ReactNode;
  confirmLabel?: string;
  testId?: string;
}) {
  const m = directoryMessages(locale);
  const [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState<ChangeFailure | null>(null);
  useUnsavedChanges(withReason && reason.trim() !== "");
  const run = async (again: boolean) => {
    setBusy(true);
    setProblem(null);
    try {
      await submit(withReason ? reason : null, again);
    } catch (e) {
      if (!silent(e)) setProblem({ failure: e, scope, retry: () => void run(true) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="panel stack"
      data-testid={testId}
      onSubmit={(e) => {
        e.preventDefault();
        void run(false);
      }}
    >
      <h3>{title ?? m.archive}</h3>
      <p>{help ?? m.archiveHelp}</p>
      <ChangeProblem
        locale={locale}
        problem={problem}
        ledger={ledger}
        busy={busy}
        onCheck={onCheck}
        onDismiss={() => setProblem(null)}
      />
      {withReason && (
        <label>
          {m.reason} *<input name="reason" required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      )}
      <div className="row">
        <button disabled={busy}>{confirmLabel ?? m.archive}</button>
        <button type="button" onClick={onCancel}>
          {m.cancel}
        </button>
      </div>
    </form>
  );
}
