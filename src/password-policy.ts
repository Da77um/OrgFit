// ---------------------------------------------------------------------------
// The password policy this installation enforces, in one place so the sign-in
// screen, the activation screen, the API and the development bootstrap all
// state the same rule and none of them can quietly relax it.
//
// Separate from src/password.ts on purpose: that module imports node:crypto and
// must never reach a browser bundle, while this one is pure data and is
// imported by the activation form so the rule shown beside the field is the
// same rule the server applies.
//
// It is a DEVELOPMENT baseline. A production installation authenticates through
// the identity provider P-005 selects, and that provider's own policy governs.
// Nothing here is a claim that eight characters is sufficient for real staff
// credentials.
// ---------------------------------------------------------------------------

export const PASSWORD_POLICY = {
  minLength: 8,
  maxLength: 200,
  requiresLetterAndDigit: true,
} as const;

export type PolicyFailure = "TOO_SHORT" | "TOO_LONG" | "NEEDS_LETTER_AND_DIGIT";

export function checkPasswordPolicy(password: string): PolicyFailure | null {
  if (password.length < PASSWORD_POLICY.minLength) return "TOO_SHORT";
  if (password.length > PASSWORD_POLICY.maxLength) return "TOO_LONG";
  // Arabic letters count as letters. A rule that only accepted A-Z would be a
  // Latin rule wearing a general name in an Arabic-first product.
  if (!/[A-Za-z؀-ۿ]/.test(password) || !/[0-9٠-٩]/.test(password))
    return "NEEDS_LETTER_AND_DIGIT";
  return null;
}
