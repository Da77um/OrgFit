/**
 * Auth0 post-login Action for the OrgFit tenant (D-167).
 *
 * OrgFit accepts a staff sign-in only when the ID token's `acr` claim proves
 * multi-factor authentication (src/auth.ts → assertMfa, OIDC_MFA_ACR). Auth0
 * sets that claim only when MFA actually ran in this login, so every login is
 * challenged with the one-time password, or enrolls it the first time.
 *
 * This uses the factor methods, so the tenant needs Security → Multi-factor
 * Auth → Additional Settings → Customize MFA Factors using Actions ON. On the
 * same page, Allow Users to Skip MFA on Trusted Browsers must be OFF: when on,
 * Auth0 skips the challenge on a remembered browser, the token has no MFA
 * `acr`, and OrgFit refuses the sign-in with MFA_NOT_PROVEN (2026-10-11).
 *
 * Paste into Auth0: Actions → Library → Build Custom → Login / Post Login,
 * then deploy it and add it to the Login flow. This is the deployed version 1.
 */
exports.onExecutePostLogin = async (event, api) => {
  const enrolled = (event.user.multifactor || []).length > 0;
  if (enrolled) {
    api.authentication.challengeWith({ type: "otp" });
  } else {
    api.authentication.enrollWith({ type: "otp" });
  }
};
