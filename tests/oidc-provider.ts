import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
// Isolated signed OIDC fixture. Never imported by application builds.
// The staff origin is a parameter so that scripts/showcase.ts can bring the
// same provider up beside the Playwright harness on its own port pair. The
// redirect target is still pinned to exactly one origin per provider instance.
// The release rehearsal (Phase 15) serves it behind a TLS proxy, so the issuer
// it advertises can be the public https URL rather than its own listener.
export async function testProvider(
  port = 4010,
  staffOrigin = "http://127.0.0.1:3000",
  publicIssuer?: string,
) {
  const issuer = publicIssuer ?? `http://127.0.0.1:${port}`,
    keys = await generateKeyPair("RS256"),
    jwk = await exportJWK(keys.publicKey);
  const codes = new Map<
    string,
    {
      nonce: string;
      challenge: string;
      redirect: string;
      subject: string;
      mode: string;
    }
  >();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", issuer);
      if (url.pathname === "/.well-known/openid-configuration") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
            token_endpoint_auth_methods_supported: ["client_secret_post"],
            code_challenge_methods_supported: ["S256"],
          }),
        );
        return;
      }
      if (url.pathname === "/jwks") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            keys: [{ ...jwk, kid: "fixture", alg: "RS256", use: "sig" }],
          }),
        );
        return;
      }
      if (url.pathname === "/authorize") {
        const escape = (s: string) =>
          s
            .replaceAll("&", "&amp;")
            .replaceAll('"', "&quot;")
            .replaceAll("<", "&lt;");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          `<html lang="en"><body><h1>Synthetic test identity provider</h1><form action="/approve">${[...url.searchParams].map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`).join("")}<label>Identity<select name="subject"><option>staff</option><option>admin</option><option>unknown</option><option>disabled</option></select></label><label>Test case<select name="mode">${["normal", "no-mfa", "bad-state", "bad-nonce", "bad-audience", "bad-issuer", "bad-signature", "expired"].map((s) => `<option>${s}</option>`).join("")}</select></label><button>Sign in</button></form></body></html>`,
        );
        return;
      }
      if (url.pathname === "/approve") {
        if (
          url.searchParams.get("client_id") !== "orgfit-test" ||
          url.searchParams.get("redirect_uri") !==
            staffOrigin + "/api/v1/auth/callback" ||
          url.searchParams.get("code_challenge_method") !== "S256"
        ) {
          res.writeHead(400).end();
          return;
        }
        const code = randomUUID(),
          mode = url.searchParams.get("mode") ?? "normal";
        codes.set(code, {
          nonce: url.searchParams.get("nonce") ?? "",
          challenge: url.searchParams.get("code_challenge") ?? "",
          redirect: url.searchParams.get("redirect_uri")!,
          subject: url.searchParams.get("subject") ?? "staff",
          mode,
        });
        const callback = new URL(url.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", code);
        callback.searchParams.set(
          "state",
          mode === "bad-state"
            ? "incorrect"
            : (url.searchParams.get("state") ?? ""),
        );
        res.writeHead(302, { Location: callback.href }).end();
        return;
      }
      if (url.pathname === "/token" && req.method === "POST") {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 8192) {
            res.writeHead(413).end();
            return;
          }
        }
        const form = new URLSearchParams(body),
          code = form.get("code") ?? "",
          entry = codes.get(code);
        codes.delete(code);
        if (
          !entry ||
          form.get("client_id") !== "orgfit-test" ||
          form.get("client_secret") !== "synthetic-oidc-test-secret" ||
          form.get("redirect_uri") !== entry.redirect ||
          createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url") !== entry.challenge
        ) {
          res
            .writeHead(400, { "Content-Type": "application/json" })
            .end('{"error":"invalid_grant"}');
          return;
        }
        const signingKey =
          entry.mode === "bad-signature"
            ? (await generateKeyPair("RS256")).privateKey
            : keys.privateKey;
        const token = await new SignJWT({
          nonce: entry.mode === "bad-nonce" ? "wrong" : entry.nonce,
          acr: entry.mode === "no-mfa" ? "password" : "urn:test:mfa",
          amr: ["pwd", "otp"],
          auth_time: Math.floor(Date.now() / 1000),
        })
          .setProtectedHeader({ alg: "RS256", kid: "fixture" })
          .setIssuer(
            entry.mode === "bad-issuer" ? "https://wrong.invalid" : issuer,
          )
          .setAudience(
            entry.mode === "bad-audience" ? "another-client" : "orgfit-test",
          )
          .setSubject(entry.subject)
          .setIssuedAt()
          .setExpirationTime(
            entry.mode === "expired"
              ? Math.floor(Date.now() / 1000) - 300
              : "5m",
          )
          .sign(signingKey);
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            access_token: "synthetic-not-retained",
            token_type: "Bearer",
            expires_in: 300,
            id_token: token,
          }),
        );
        return;
      }
      res.writeHead(404).end();
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  return server;
}
