"use client";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// A ranking answer (D-185), shared by the staff preview and the respondent.
//
// Fully usable without drag: every item has "move up" / "move down" buttons
// with a spoken name, a visible position number, and ArrowUp / ArrowDown on a
// focused move button moves that item. Focus follows the moved item, and a
// polite live region says where it went. Vertical movement reads the same in
// RTL and LTR; the layout uses logical properties only.
//
// An untouched list is NOT an answer: the order shown is the option order
// until the respondent moves an item or keeps the order as shown. Then the
// value is always a full permutation of the options, which is the only
// present answer src/answer-rules.ts accepts. "Clear" returns to no answer.
// Pure presentation: no storage, network or locale lookup of its own.
// ---------------------------------------------------------------------------

export type RankingText = {
  moveUp: (item: string) => string;
  moveDown: (item: string) => string;
  position: (n: number, total: number) => string;
  moved: (item: string, n: number, total: number) => string;
  keep: string;
  clear: string;
  unranked: string;
  ranked: string;
  keyboard: string;
};

/** True when `value` is a full ranking of exactly these option ids. */
export function isFullRanking(optionIds: string[], value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length === optionIds.length &&
    new Set(value).size === value.length &&
    value.every((v) => typeof v === "string" && optionIds.includes(v))
  );
}

export function RankingControl({
  id,
  options,
  value,
  onChange,
  text,
  legend,
  notes,
  describedBy,
  invalid,
  onBlur,
}: {
  id: string;
  options: { id: string; label: string }[];
  value: unknown;
  onChange: (order: string[]) => void;
  text: RankingText;
  legend?: ReactNode;
  notes?: ReactNode;
  describedBy?: string;
  invalid?: boolean;
  onBlur?: () => void;
}) {
  const ids = options.map((o) => o.id);
  const ranked = isFullRanking(ids, value);
  const order = ranked ? value : ids;
  const total = order.length;
  const labelOf = (oid: string) => options.find((o) => o.id === oid)?.label ?? "";
  const [announce, setAnnounce] = useState("");
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const move = (index: number, by: -1 | 1) => {
    const target = index + by;
    if (target < 0 || target >= total) return;
    const next = [...order];
    const moved = next[index];
    next[index] = next[target];
    next[target] = moved;
    onChange(next);
    setAnnounce(text.moved(labelOf(moved), target + 1, total));
    // Keep focus on the item that moved; at an end its button in that
    // direction is disabled, so focus its other button.
    const direction =
      target === 0 ? "down" : target === total - 1 ? "up" : by < 0 ? "up" : "down";
    requestAnimationFrame(() =>
      buttons.current.get(`${moved}:${direction}`)?.focus(),
    );
  };

  const content = (
    <>
      {notes}
      <p className="field-hint ranking-keyboard">{text.keyboard}</p>
      <ol className="ranking-list">
        {order.map((oid, i) => {
          const label = labelOf(oid);
          const keyed = (dir: "up" | "down") => (el: HTMLButtonElement | null) => {
            if (el) buttons.current.set(`${oid}:${dir}`, el);
            else buttons.current.delete(`${oid}:${dir}`);
          };
          const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              move(i, e.key === "ArrowUp" ? -1 : 1);
            }
          };
          return (
            <li
              key={oid}
              className="ranking-item"
              data-ranked={ranked ? "true" : undefined}
            >
              <span className="ranking-position num" aria-hidden="true">
                {i + 1}
              </span>
              <span className="ranking-label">
                <span className="visually-hidden">{text.position(i + 1, total)} </span>
                {label}
              </span>
              <span className="ranking-moves">
                <button
                  type="button"
                  className="ranking-move"
                  ref={keyed("up")}
                  aria-label={text.moveUp(label)}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  onKeyDown={onKeyDown}
                >
                  <span aria-hidden="true">↑</span>
                </button>
                <button
                  type="button"
                  className="ranking-move"
                  ref={keyed("down")}
                  aria-label={text.moveDown(label)}
                  disabled={i === total - 1}
                  onClick={() => move(i, 1)}
                  onKeyDown={onKeyDown}
                >
                  <span aria-hidden="true">↓</span>
                </button>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="ranking-actions">
        <span className="ranking-state" data-ranked={ranked ? "true" : undefined}>
          {ranked ? text.ranked : text.unranked}
        </span>
        {ranked ? (
          <button type="button" onClick={() => onChange([])}>
            {text.clear}
          </button>
        ) : (
          <button type="button" onClick={() => onChange([...order])}>
            {text.keep}
          </button>
        )}
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announce}
      </p>
    </>
  );
  // With a legend it is its own named group (the respondent's question); the
  // staff preview already wraps each question in a fieldset and passes none.
  return legend === undefined ? (
    <div className="ranking" data-slot={id} onBlur={onBlur}>
      {content}
    </div>
  ) : (
    <fieldset
      className="survey-question ranking"
      data-slot={id}
      data-invalid={invalid ? "true" : undefined}
      aria-describedby={describedBy}
      onBlur={onBlur}
    >
      <legend>{legend}</legend>
      {content}
    </fieldset>
  );
}
