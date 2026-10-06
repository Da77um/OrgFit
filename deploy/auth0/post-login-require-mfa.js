/**
 * Auth0 post-login Action for the OrgFit tenant (D-167).
 *
 * OrgFit accepts a staff sign-in only when the ID token's `acr` claim proves
 * multi-factor authentication (src/auth.ts → assertMfa, OIDC_MFA_ACR). Auth0
 * sets that claim only when MFA actually ran in this login, so MFA is required
 * on every login and a remembered browser may not skip it. Without this, a
 * remembered browser would yield a token without the MFA `acr`, and OrgFit
 * would refuse the sign-in.
 *
 * Paste into Auth0: Actions → Library → Build Custom → Login / Post Login,
 * then deploy it and add it to the Login flow.
 */
exports.onExecutePostLogin = async (event, api) => {
  api.multifactor.enable("any", { allowRememberBrowser: false });
};
