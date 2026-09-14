# OrgFit staff operations guide (Phase 15)

2026-09-14. For OrgFit consultants and Super Admins using the release candidate. It describes what the product does today, including what it deliberately cannot do. Questionnaire content, band names and recommendation wording in the product are **illustrative** until the instrument owner approves real content (P-006). Nothing here authorizes collecting real respondent data: that requires the production inputs in [final-handoff.md](final-handoff.md).

The interface is Arabic by default (right to left). Switch to English with the language control in the app bar; your choice is saved on your profile.

## 1. Access and roles

- **Sign-in** is through the organization's identity provider with multi-factor authentication (`/login` → *Continue with identity provider*). There is no public registration and no client or respondent account.
- A **Super Admin** manages staff, capabilities and organization assignments and can read every organization. A **Staff** member sees only the organizations assigned to them, and only what their capabilities allow:

| Capability | Lets you |
|---|---|
| `directory.manage` | Create and edit organizations, departments and participants; import participant lists |
| `instruments.manage` | Build, publish and version questionnaires; review history comparisons |
| `campaigns.manage` | Create rounds and campaigns, launch, issue links, close |
| `participation.read` / `participation.export` | See / export the named completion list |
| `results.read` | Read published results and recommendations |
| `reports.manage` | Request and download PDF/XLSX reports |
| `visits.manage` | Record field visits, follow-ups and attachments |

- Changing a person's role, status, capabilities or organizations **signs them out everywhere** at once. Sessions end after 30 minutes idle or 12 hours absolute.
- New staff are invited by a Super Admin; the invitation fixes their role and access, and the invitee can set only their name and credentials. (The development-only password path is switched off in every real environment.)

## 2. Directories

1. **Organizations** → *Add*: code, Arabic name, optional English name, timezone. Archive instead of deleting; archived records stay readable.
2. **Departments**: a flat or nested list per organization. A department with active members or children cannot be archived.
3. **Participants**: private reference, display name, optional department. These records are identified data about people — keep only the fields the data steward approved (P-007).
4. **Import** (CSV UTF-8 or a single-sheet XLSX; at most 1 MiB, 500 rows, 30 columns): upload → map columns → review every row error → confirm. Nothing is written until you confirm, and only valid rows are committed. Formulas and active content are refused. The uploaded file expires after 24 hours.

## 3. Questionnaires

1. **Questionnaires** → create a blank questionnaire or copy a built-in template.
2. Add sections and questions. Every question is **mandatory by default**; mark a question optional explicitly. There is **no skip or conditional logic** — every respondent sees every question.
3. Write both Arabic and English text if the campaign will offer both languages.
4. Configure dimensions, item scoring (including reverse scoring and weights), the overall score and interpretation bands, and any recommendation rules.
5. Use **Synthetic preview** to answer as a test respondent and check scores against band edges. Preview answers are never saved.
6. **Publish.** A published version is immutable — text, translations, scoring, bands and rules. To change anything, create a **new version**; campaigns already launched keep the version they were launched with.

## 4. Campaigns and invitation links

1. In an organization, **Assessments** → create a **series** (a questionnaire family measured over time) and a **round** in it.
2. Create the round's **campaign**: published version, target (one person, a selected list, or a department's own members), start, optional end, timezone.
3. Read the **launch review**. It says whether the campaign can ever release results: fewer invitees than the threshold (at least five) means it cannot.
4. **Launch.** Launch freezes the roster, the report groups, the questionnaire version and the privacy notice. Later directory edits do not change a launched campaign.
5. **Generate links manually.** For each person, *Issue* reveals the link **once**. Copy it and deliver it yourself through an approved channel — **OrgFit never sends email or messages.** A link is a bearer credential: whoever holds it can answer.
   - Lost an unused link? **Rotate** it (the old link stops working). You cannot retrieve an issued link.
   - Need to withdraw someone? **Revoke** their invitation.
   - A completed invitation can be neither rotated nor revoked.
   - For many people, a **link export** produces one encrypted file that expires after 24 hours.

### What respondents experience

- The link opens the survey on the survey address, in Arabic by default, with the privacy notice first.
- Answers can be **saved and resumed**. Drafts are encrypted **in the respondent's browser**; OrgFit stores only ciphertext.
- On the same device, resuming is automatic. On another device, the respondent needs the original link **and their private resume code**, shown to them when they first save.
- **Staff cannot see, recover or reset a resume code.** If a respondent loses it, the only option is *Start over* from the original link. Do not promise otherwise.
- Submission is **final and happens once**. After it, the link shows that the answers were received; it cannot be used to change or submit again.

## 5. Tracking outstanding participants

**Campaign → Participation** lists each invited person with status (not issued / issued / completed / revoked) and totals: invited, completed, revoked, outstanding, eligible and response rate. It updates live.

It shows **who has completed, never what anyone answered**. There is no staff view of a draft, no individual answer, no individual score and no way to link a completion to a response — by design, not by permission. Reminders are yours to send outside OrgFit.

## 6. Closing and publishing results

1. **Close** the campaign (or let its end date pass). Closing is final; there is no reopen.
2. The **privacy processor** runs on its own schedule under a separate credential. It moves accepted answers into the separate anonymous store, stripping every identity and transport field, and then erases the intake.
   - **Below the threshold** (fewer than five valid contributors) nothing is decrypted: the intake is purged and the round shows that **no results will ever be published** for it.
3. The **publication job** then builds one immutable release after its disclosure checks. Results appear under **Results** for that round.

Results are never edited in place. There is currently **no product workflow to revoke or correct a published release** (SEC-M5); if a release must be withdrawn, escalate to the release owner — do not attempt it in the database.

## 7. Reading results and suppression

Three views: **Overview** (overall and dimension scores, bands, strengths and areas to review), **Departments** (department versus company), **Questions** (option shares and bounded numeric summaries, company level).

A withheld value is **empty**, with a status and a reason — never a zero:

| Status | Meaning |
|---|---|
| Available | Released after every check |
| Suppressed — too few contributors | Fewer valid contributors to that metric than the threshold |
| Suppressed — homogeneous | Everyone gave the same value, so the average would reveal each answer |
| Suppressed — complementary | A department cell would let someone subtract their way to a withheld group, so the whole department breakdown for that metric is withheld |
| Unscored | No valid score in that group |
| Not comparable | A history comparison whose measurement changed |

- Free text and dates are never shown as values. Numbers show a bounded average, never a minimum, maximum or histogram.
- The only filter is language. Department filters, excluding people, time slices and demographic cuts are refused.
- **Recommendations** are deterministic rules from the published questionnaire applied to released values only; a rule touching a withheld value does not fire. There is no AI.
- **Know the limit (CE-001).** Where two releases of the same group differ by only a few contributors, comparing them can reveal one person's score. The product states this where it applies. Do not attempt such comparisons, and do not present five-contributor thresholds as a guarantee of anonymity.

## 8. History comparisons

**History** plots a series' released rounds. Comparing two rounds requires a recorded **review** by someone with `instruments.manage`, declaring which metrics measure the same thing. A metric whose scoring changed cannot be declared equivalent. Withheld values stay gaps. No participant is ever linked across rounds.

## 9. Reports

1. From a published round, **Reports** → choose PDF or XLSX, Arabic or English, optionally a reviewed comparison → *Request report*.
2. A separate renderer process produces it; the row changes from *Waiting* to *Ready*.
3. **Download** within 24 hours. Every download re-checks your current access.

Reports contain exactly the released values — withheld cells stay empty with their reason — and **no names**. The named **participation export** is a separate file with its own capability; it contains names and completion status and nothing about answers.

## 10. Field visits

1. **Visits** → *New visit*: consultant, date and time (in the visit's timezone), purpose, optionally the related round.
2. Move it through **Scheduled → In progress → Completed**, or cancel with a reason. A completed visit can only be **amended** with a reason; it never reopens.
3. Add **follow-up actions** with an owner and due date; overdue items appear in the follow-up list.
4. **Attachments** (PDF, images, DOCX, XLSX, up to 20 MB) are quarantined on upload and downloadable only after the scanner marks them clean. The bundled scanner verifies file types; it is **not an antivirus engine** (P-010).

Visit records are identified consulting material. Never paste respondent answers, resume codes or links into a visit.

## 11. What to escalate

| Situation | Escalate to |
|---|---|
| A respondent says they submitted but the link still opens the survey | Release owner / operator (possible restore incident) |
| Results missing long after closure, or a "publication blocked" notice | Operator (`ops:check`) |
| A request to see who answered what, or to delete one person's answers | Privacy lead — the product cannot do either; erasure is whole-campaign only |
| A lost or leaked invitation link | Rotate or revoke it yourself; report a suspected leak to the operator |
| Anything that looks like another organization's data | Security contact, immediately |
