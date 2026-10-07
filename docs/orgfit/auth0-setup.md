# Step 4: staff sign-in with Auth0

Status: the owner chose Auth0 (D-167, P-005). OrgFit's code needs no change for Auth0. The settings, the MFA Action and `npm run oidc:check` are ready and tested against the synthetic provider. **No Auth0 tenant exists yet.** The owner creates it and enters every secret.

## What OrgFit requires (and why each setting below exists)

| OrgFit does (`src/auth.ts`) | So Auth0 must |
|---|---|
| Authorization code flow with PKCE S256, `scope=openid` only | be a **Regular Web Application** with the Authorization Code grant |
| Sends the client secret in the POST body (openid-client's default) | use **Client Secret (Post)** |
| Verifies the ID token signature against the provider's keys | sign with **RS256** (the default) |
| Refuses unless the ID token's `acr` is in `OIDC_MFA_ACR` | run MFA on **every** login. The Action below does this; Auth0 then sets `acr` to `http://schemas.openid.net/pape/policies/2007/06/multi-factor` |
| `max_age=0`: a fresh sign-in each time | (nothing; Auth0 honors it) |
| Compares the token's `iss` to `OIDC_ISSUER` exactly | set `OIDC_ISSUER` to `https://<your-domain>/`, **with the trailing slash** |
| Identifies staff by issuer + Auth0 user id, never by email | create the first Super Admin from that exact user id |

## Steps (owner)

1. **Create an Auth0 account and tenant.** Name it `orgfit-staging`, region **Japan** if offered (closest to Tokyo), environment Development. Check that your plan includes the MFA factors you want.
2. **Create the application:**
   - Go to **Applications → Create Application → "Regular Web Applications"**, name it `OrgFit Staff`.
   - Settings tab: **Allowed Callback URLs** = `http://127.0.0.1:3000/api/v1/auth/callback`. Add your Vercel staff domain later as `https://<staff-domain>/api/v1/auth/callback`. Leave Logout URLs and Web Origins empty.
   - **Credentials** tab: Authentication Method = **Client Secret (Post)**.
   - **Advanced Settings → Grant Types**: only **Authorization Code**. Untick Implicit, Refresh Token and Client Credentials.
   - **Advanced Settings → OAuth**: JSON Web Token signature **RS256**, OIDC Conformant **on**.
3. **Lock down who can sign up:**
   - **Authentication → Database → Username-Password-Authentication**: turn on **Disable Sign Ups**.
   - **Application → Connections** tab: enable only that database connection, and turn social logins off.
   - OrgFit also refuses anyone it hasn't provisioned, but nobody should be able to create an account.
4. **Require MFA on every login:**
   - **Security → Multi-factor Auth**: enable **One-time Password** (an authenticator app). Optionally enable **WebAuthn with FIDO Security Keys** too.
   - On the same page, under **Additional Settings**, turn on **Customize MFA Factors using Actions**. Without it, Auth0 refuses every sign-in after the password with `invalid_request: MFA customized via PostLogin action but feature is not enabled` (found on the first staging sign-in, 2026-10-07).
   - **Actions → Library → Build Custom** → trigger **Login / Post Login**. Paste `deploy/auth0/post-login-require-mfa.js`, then **Deploy**.
   - **Actions → Triggers → post-login**: drag it into the flow and **Apply**.
5. **Create your own user:**
   - **User Management → Users → Create User**, with the Username-Password connection, your email and a strong password.
   - Open the user and copy its **user_id** (looks like `auth0|65f…`).
6. **Fill in `.env.staging.staff`.** The lines are already there:
   - `OIDC_ISSUER` = `https://` + the application's **Domain** + `/`, e.g. `https://orgfit-staging.jp.auth0.com/`
   - `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`: from the application.
   - `OIDC_MFA_ACR` is already set; don't change it.
7. **Check before signing in:**

   ```
   npm run oidc:check -- --env-file .env.staging.staff
   ```

   This proves the issuer matches exactly and the endpoints are right, and that the client id, secret and secret method are accepted. It doesn't sign anyone in. It must show no FAIL. A WARN about acr values only means Auth0 doesn't advertise them; step 9 proves it.
8. **Make yourself the first Super Admin:**
   - In `.env.staging.operator`, fill `BOOTSTRAP_ISSUER` (the same value as `OIDC_ISSUER`), `BOOTSTRAP_SUBJECT` (your user_id), `BOOTSTRAP_EMAIL` and `BOOTSTRAP_NAME`.
   - Run `npm run db:bootstrap` with that file loaded: `node --env-file=.env.staging.operator node_modules/tsx/dist/cli.mjs scripts/bootstrap.ts`.
   - It runs once and refuses if any staff member already exists. Afterwards, clear the four BOOTSTRAP lines.
9. **Sign in for real** (local staff app against the staging database):

   ```
   node --env-file=.env.staging.staff node_modules/next/dist/bin/next dev apps/staff --hostname 127.0.0.1 --port 3000
   ```

   Open `http://127.0.0.1:3000`, choose sign-in, log in at Auth0, and enroll the authenticator app. You should arrive as Super Admin. If OrgFit refuses, the token had no MFA `acr`: check that the Action is in the post-login flow.
10. **On Vercel:**
    - Add the real staff callback URL in Auth0 (step 2).
    - Set the four `OIDC_*` variables in the `orgfit-staff` project.
    - Run `oidc:check` against the production values with `--production`.

## Know before you click

- **Never put the client secret anywhere but the staff settings file and the `orgfit-staff` Vercel project.** Preflight refuses it in every other process.
- **Adding staff later:**
  1. Create the person in Auth0 (step 5) and copy their `user_id`.
  2. A Super Admin registers them in OrgFit on the **Staff** screen's register form, with email, name and that `user_id` as the provider subject. The issuer is fixed to `OIDC_ISSUER` (`src/administration.ts`).
  3. An Auth0 account alone grants nothing.

  The email invitation and activation flow is for local passwords only, so it stays unavailable here.
- Development password sign-in stays switched off on Supabase (D-164). Auth0 is the only way in.
