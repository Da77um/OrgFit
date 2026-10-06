# Database CA certificates

`supabase-root-2021-ca.crt` is Supabase's public root CA ("Supabase Root 2021 CA", self-signed, CA:TRUE, valid to 2031-04-26). It holds no private key and is not a secret. Database URLs name it with `sslrootcert`, so `sslmode=verify-full` checks the server's certificate chain and host name (D-164, D-165).

The deployed apps run from their own folder (`apps/staff`, `apps/respondent`, `apps/jobs`), so their URLs use the relative path `sslrootcert=../../deploy/certs/supabase-root-2021-ca.crt`. Each app's `next.config.ts` traces this folder into its build with `outputFileTracingIncludes`. The URL names the file by path and never imports it, so the build would otherwise leave it out.

Replace the file only with a certificate downloaded from the Supabase dashboard (Project Settings → Database → SSL Configuration), and check its subject before committing.
