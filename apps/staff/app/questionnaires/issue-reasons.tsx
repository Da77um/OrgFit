"use client";
import {
  locateIssue,
  type DefinitionIssue,
  type Instrument,
} from "../../../../src/instrument-input";
import {
  describeLocation,
  instrumentMessages,
  issueMessage,
} from "../../../../src/instrument-i18n";

// Why something cannot be scored, worded and located as the publication
// checklist words and locates it (D-172), with the same way to the field.
export function IssueReasons({
  document: d,
  issues,
  locale,
  onReveal,
}: {
  document: Instrument;
  issues: DefinitionIssue[];
  locale: "ar" | "en";
  onReveal?: (issue: DefinitionIssue) => void;
}) {
  return (
    <ul>
      {issues.map((x, i) => {
        const loc = x.location ?? locateIssue(d, x.path);
        return (
          <li key={i}>
            {loc && (
              <>
                <strong>
                  <bdi>{describeLocation(loc, locale)}</bdi>
                </strong>
                {": "}
              </>
            )}
            {issueMessage(x.code, locale)}{" "}
            {loc && onReveal && (
              <a
                href={`#field-${x.path}`}
                onClick={(e) => {
                  e.preventDefault();
                  onReveal({ ...x, location: loc });
                }}
              >
                {instrumentMessages(locale).goTo}
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}
