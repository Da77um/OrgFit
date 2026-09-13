import { messages, type Locale } from "../../../src/i18n";

// fetch for the staff screens, failing in the reader's language.
//
// A dropped connection rejects with the browser's own text ("Failed to fetch",
// "NetworkError when attempting to fetch resource") and a proxy's error page
// is not JSON, so without this a screen would print an English engine message
// or a parser's complaint where it means "the service did not answer".
export const staffFetch =
  (locale: Locale) => (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, init).catch(() => {
      throw new Error(messages(locale).unavailable);
    });

/** The JSON body, or an empty object when there is none to read. */
export const jsonOf = (response: Response) =>
  // Typed as fetch types it (any), exactly as the call it replaces.
  response.json().catch(() => ({}));
