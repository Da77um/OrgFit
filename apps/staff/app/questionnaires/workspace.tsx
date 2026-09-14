"use client";
import { ChangeProblem, silent, useStaffApi, type ChangeFailure } from "../request-ui";
import { RequestFailure } from "../staff-request";
import { navigateAfterSave, useUnsavedChanges, type SaveOutcome } from "../unsaved";
/* Full navigation deliberately clears organization context and draft state. */
import { useEffect, useState, useCallback } from "react";
import type { Profile } from "../../../../src/db";
import type { Version } from "../../../../src/instruments";
import {
  type Instrument,
  questionTypes,
  type QuestionType,
  instrumentSchema,
  definitionIssues,
  newQuestion,
  newIdentity,
  tr,
  duplicateItem,
  moveItem,
} from "../../../../src/instrument-input";
import { Translated, Order, QuestionEditor, DimensionsEditor } from "./editors";
import { RulesEditor } from "./rules-editor";
import { AppBar } from "../shell";
import {
  Badge,
  EmptyState,
  ErrorState,
  Label,
  LoadingState,
  Micro,
  PageHeader,
} from "../../../../src/ui";
import { InstrumentPreview } from "./preview";
import type { QuestionnaireTarget } from "../../../../src/instruments";
import {
  TargetPicker,
  TargetSummary,
  entireOrganization,
  organizationName,
  departmentName,
  targetBody,
  targetComplete,
  useDepartmentOptions,
  type TargetValue,
} from "./target-picker";
type LibraryItem = {
  id: string;
  name_ar: string;
  name_en: string;
  source: string;
  status: string;
  revision: string;
} & Partial<QuestionnaireTarget>;
type LibraryDetail = LibraryItem & {
  organization_id: string | null;
  versions: {
    id: string;
    version_number: number;
    state: string;
    revision: string;
  }[];
};
export function InstrumentWorkspace({
  profile,
  organizations,
  org,
  path,
}: {
  profile: Profile;
  organizations: { id: string; name_ar: string; name_en: string | null }[];
  org: string | null;
  path: string[];
}) {
  const locale = profile.locale,
    t = useCallback(
      (ar: string, en: string) => (locale === "ar" ? ar : en),
      [locale],
    );
  const [ready, setReady] = useState(false),
    [list, setList] = useState<LibraryItem[]>([]),
    [detail, setDetail] = useState<LibraryDetail | null>(null),
    [version, setVersion] = useState<Version | null>(null),
    [doc, setDoc] = useState<Instrument | null>(null),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [tab, setTab] = useState("build"),
    [q, setQ] = useState(""),
    [status, setStatus] = useState("ACTIVE"),
    [cursor, setCursor] = useState<string | null>(null),
    [title, setTitle] = useState(tr()),
    [creating, setCreating] = useState(false),
    [cloneTarget, setCloneTarget] = useState(org ?? ""),
    [issues, setIssues] = useState<{ path: string; code: string }[]>([]),
    [newTypes, setNewTypes] = useState<Record<string, QuestionType>>({}),
    // Department targeting beneath the organization. Changing an organization
    // clears its department selection in the same event, so identifiers from
    // one organization are never carried into another.
    [createOrg, setCreateOrg] = useState(org ?? ""),
    [createTarget, setCreateTarget] = useState<TargetValue>(entireOrganization),
    [cloneTargetValue, setCloneTargetValue] = useState<TargetValue>(entireOrganization),
    [editTarget, setEditTarget] = useState<TargetValue>(entireOrganization),
    [targetDirty, setTargetDirty] = useState(false),
    [departmentFilter, setDepartmentFilter] = useState("");
  const base = `/api/v1/${org ? `organizations/${org}/` : ""}questionnaires`,
    suffix = org ? `?organization=${org}` : "";
  const canManage =
      profile.role === "SUPER_ADMIN" ||
      profile.capabilities.includes("instruments.manage"),
    editable =
      canManage &&
      detail?.source !== "BUILTIN" &&
      detail?.status === "ACTIVE" &&
      version?.state === "DRAFT";
  // Bounded requests; every change keyed per logical attempt (Post-Audit
  // Repair Pass 2). A change that carries a revision may replace an
  // unconfirmed one in its scope (a stale revision is refused); a create may
  // not. `again` re-sends the scope's unconfirmed attempt unchanged.
  const client = useStaffApi(locale);
  const [problem, setProblem] = useState<ChangeFailure | null>(null);
  const scopeOptions = useDepartmentOptions(client.read, org),
    createOptions = useDepartmentOptions(client.read, createOrg || null),
    cloneOptions = useDepartmentOptions(client.read, cloneTarget || null);
  const orgLabel = (id: string | null) =>
    organizationName(organizations.find((o) => o.id === id), locale);
  const api = useCallback(
    async (
      url: string,
      method: "GET" | "POST" | "PATCH" = "GET",
      body?: unknown,
      revision?: string,
      scope?: string,
      again = false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): Promise<any> => {
      try {
        if (method === "GET") return await client.read(url);
        const s = scope ?? `${method} ${url}`;
        return again
          ? await client.retry(s)
          : await client.mutate(s, url, { method, body, revision, replace: revision !== undefined });
      } catch (e) {
        if (!(e instanceof RequestFailure)) throw e;
        const issues = e.body?.issues;
        if (Array.isArray(issues)) setIssues(issues);
        if (e.uncertain || e.kind === "SESSION" || e.kind === "CANCELLED" || e.kind !== "REJECTED") throw e;
        throw Object.assign(
          new RequestFailure(
            e.status === 409 && e.code !== "IDEMPOTENCY_CONFLICT"
              ? t(
                  "تعارض مع نسخة أحدث. احتفظ بتعديلاتك ثم أعد تحميل النسخة؛ لم تُستبدل بياناتك.",
                  "A newer revision exists. Keep your edits, then reload the version; your changes were not overwritten.",
                )
              : e.message ||
                  t(
                    "تعذر تنفيذ العملية. راجع الأخطاء وحاول مجدداً.",
                    "Could not complete the operation. Review errors and retry.",
                  ),
            e.kind,
            { status: e.status, code: e.code, body: e.body },
          ),
          { attempt: e.attempt },
        );
      }
    },
    [client, t],
  );
  // An unknown outcome or an ended session is shown with its exact retry; a
  // refusal is shown as before.
  const fail = useCallback((e: unknown, scope?: string, retry?: () => void) => {
    if (silent(e)) return;
    if (e instanceof RequestFailure && (e.uncertain || e.kind === "SESSION"))
      setProblem({ failure: e, scope, retry });
    else setError(e instanceof Error ? e.message : "");
  }, []);
  const loadList = useCallback(
    async (after?: string, department = departmentFilter) => {
      const data = await api(
        `${base}?${new URLSearchParams({
          q,
          status,
          ...(after ? { cursor: after } : {}),
          ...(org && department ? { departmentId: department } : {}),
        })}`,
      );
      setList((old) => (after ? [...old, ...data.items] : data.items));
      setCursor(data.nextCursor);
    },
    [api, base, q, status, org, departmentFilter],
  );
  const showDetail = useCallback((data: LibraryDetail) => {
    setDetail(data);
    setEditTarget({
      mode: data.target_mode ?? "ORGANIZATION",
      departmentIds: (data.departments ?? []).map((d) => d.id),
    });
    setTargetDirty(false);
  }, []);
  useEffect(() => {
    let live = true;
    setReady(true);
    (async () => {
      try {
        if (path[0]) {
          const data = await api(`${base}/${path[0]}`);
          if (!live) return;
          showDetail(data);
          if (path[1] === "versions" && path[2]) {
            const v = await api(`${base}/${path[0]}/versions/${path[2]}`);
            if (live) {
              setVersion(v);
              setDoc(v.document);
            }
          }
        } else {
          const data = await api(base);
          if (live) {
            setList(data.items);
            setCursor(data.nextCursor);
          }
        }
      } catch (e) {
        if (live && !silent(e)) setError(e instanceof Error ? e.message : "");
      }
    })();
    return () => {
      live = false;
    };
  }, [api, base, path, showDetail]);
  // Autosave and the leave dialog share this one save. If an earlier save's
  // answer was lost, that exact attempt is sent again first (same key and
  // body: the server answers from its receipt), and only then is the current
  // document saved against the revision it produced.
  const save = useCallback(async (): Promise<SaveOutcome> => {
    if (!dirty) return { ok: true };
    if (!doc || !version || busy || !editable) return { ok: false };
    const parsed = instrumentSchema.safeParse(doc);
    if (!parsed.success) {
      setError(
        t(
          "بعض الحقول غير صالحة. تحقق من الأرقام والنصوص؛ يُسمح بالنص العادي فقط.",
          "Some fields are invalid. Check numbers and text; only plain text is allowed.",
        ),
      );
      return { ok: false };
    }
    const problems = definitionIssues(parsed.data);
    if (problems.length) {
      setIssues(problems);
      setError(
        t(
          "أصلح بنية الإعدادات قبل الحفظ.",
          "Fix configuration structure before saving.",
        ),
      );
      return { ok: false };
    }
    const url = `${base}/${version.questionnaire_id}/versions/${version.id}`;
    const scope = "version-save";
    setBusy(true);
    setError("");
    setProblem(null);
    try {
      let current: Version = version;
      const replayed = !!client.ledger.uncertain(scope);
      if (replayed) {
        current = await api(url, "PATCH", undefined, undefined, scope, true);
        setVersion(current);
      }
      const v: Version =
        replayed && JSON.stringify(current.document) === JSON.stringify(parsed.data)
          ? current
          : await api(url, "PATCH", parsed.data, current.revision, scope);
      setVersion(v);
      setDoc(v.document);
      // Clean only now that the server has confirmed this document.
      setDirty(false);
      setIssues([]);
      setMessage(t("تم الحفظ.", "Saved."));
      return { ok: true };
    } catch (e) {
      fail(e, scope, () => void save());
      return { ok: false };
    } finally {
      setBusy(false);
    }
  }, [dirty, doc, version, busy, editable, api, base, t, client, fail]);
  // Autosave pauses while a save is unconfirmed: the reader chooses to send it
  // again, and the edits stay protected by the leave guard meanwhile.
  useEffect(() => {
    if (!dirty || busy || error || problem) return;
    const timer = setTimeout(() => void save(), 1400);
    return () => clearTimeout(timer);
  }, [dirty, busy, error, problem, save]);
  useUnsavedChanges(dirty && editable, save);
  const change = (d: Instrument) => {
    setDoc(d);
    setDirty(true);
    setError("");
    setMessage(t("تعديلات غير محفوظة…", "Unsaved changes…"));
  };
  const action = async (name: string, again = false) => {
    if (!version || dirty) return;
    const url = `${base}/${version.questionnaire_id}/versions/${version.id}/${name}`;
    setBusy(true);
    setError("");
    setProblem(null);
    try {
      const result = await api(url, "POST", {}, version.revision, `POST ${url}`, again);
      if (name === "validate") {
        setIssues(result.issues);
        setMessage(
          result.issues.length
            ? t("راجع قائمة التحقق.", "Review the checklist.")
            : t(
                "اكتمل التحقق من تعريف الاستبيان.",
                "Definition validation passed.",
              ),
        );
      } else if (name === "new-version")
        navigateAfterSave(
          `/questionnaires/${result.questionnaire_id}/versions/${result.id}${suffix}`,
        );
      else {
        setVersion(result);
        setDoc(result.document);
        setMessage(t("تم تحديث حالة النسخة.", "Version status updated."));
      }
    } catch (e) {
      fail(e, `POST ${base}/${version.questionnaire_id}/versions/${version.id}/${name}`, () => void action(name, true));
    } finally {
      setBusy(false);
    }
  };
  const create = async (clone = false, again = false) => {
    setBusy(true);
    setError("");
    setProblem(null);
    const scope = "questionnaire-create";
    try {
      const target = clone ? cloneTarget : createOrg;
      const targeting = clone
        ? targetBody(cloneTargetValue, cloneOptions.items)
        : targetBody(createTarget, createOptions.items);
      const result = again ? await api("", "POST", undefined, undefined, scope, true) : await api(
        `/api/v1/${target ? `organizations/${target}/` : ""}questionnaires`,
        "POST",
        {
          title,
          ...(target ? { target: targeting } : {}),
          ...(clone && version
            ? {
                source: {
                  organizationId: org,
                  questionnaireId: version.questionnaire_id,
                  versionId: version.id,
                },
              }
            : {}),
        },
        undefined,
        scope,
      );
      navigateAfterSave(
        `/questionnaires/${result.questionnaire_id}/versions/${result.id}${target ? `?organization=${target}` : ""}`,
      );
    } catch (e) {
      fail(e, scope, () => void create(clone, true));
    } finally {
      setBusy(false);
    }
  };
  const saveTarget = async (again = false) => {
    if (!detail) return;
    const url = `${base}/${detail.id}/target`,
      scope = `POST ${url}`;
    setBusy(true);
    setError("");
    setProblem(null);
    try {
      const result = await api(
        url,
        "POST",
        targetBody(editTarget, scopeOptions.items),
        detail.revision,
        scope,
        again,
      );
      showDetail(result);
      setMessage(t("تم حفظ الاستهداف.", "Target saved."));
    } catch (e) {
      fail(e, scope, () => void saveTarget(true));
    } finally {
      setBusy(false);
    }
  };
  const labels = [
    t("نص قصير", "Short text"),
    t("نص طويل", "Long text"),
    t("اختيار واحد", "Multiple choice"),
    t("اختيارات متعددة", "Checkboxes"),
    t("قائمة منسدلة", "Dropdown"),
    t("نعم / لا", "Yes / no"),
    t("تقييم ١–٥", "Rating 1–5"),
    t("تقييم ١–١٠", "Rating 1–10"),
    t("مصفوفة ثابتة", "Fixed matrix"),
    t("رقم", "Number"),
    t("تاريخ", "Date"),
    t("محتوى قسم", "Section content"),
  ];
  const issueText = (code: string) =>
    ({
      TRANSLATION_REQUIRED: t(
        "أكمل نصوص اللغات المفعلة.",
        "Complete enabled-language content.",
      ),
      DUPLICATE_KEY: t("معرّف مكرر.", "Duplicate identifier."),
      QUESTION_COUNT: t(
        "يلزم سؤال واحد على الأقل وبحد أقصى ٢٠٠ عنصر إجابة.",
        "Provide 1–200 answer items.",
      ),
      TYPE_CONFIG: t(
        "إعداد غير متوافق مع نوع السؤال.",
        "Configuration does not match question type.",
      ),
      OPTIONS_REQUIRED: t(
        "أضف خيارات أو صفوفاً مكتملة.",
        "Complete options or matrix rows.",
      ),
      SELECTION_RANGE: t(
        "راجع الحدين الأدنى والأعلى للاختيارات.",
        "Check minimum and maximum selections.",
      ),
      RANGE: t(
        "الحد الأدنى يجب أن يسبق الحد الأعلى.",
        "Minimum must precede maximum.",
      ),
      REFERENCE: t(
        "مرجع مفقود أو بعد بلا أسئلة مقاسة.",
        "Missing reference or dimension without scored items.",
      ),
      SCORING_ELIGIBILITY: t(
        "نوع السؤال غير متوافق مع إعداد القياس.",
        "Question type is incompatible with scoring configuration.",
      ),
      BOUNDS_REQUIRED: t(
        "يلزم نطاق قياس معلوم وغير ثابت.",
        "Scoring requires known nonconstant bounds.",
      ),
      ATTAINABLE_BOUNDS: t(
        "راجع حدود الخيارات ودقة الأرقام؛ يجب أن تسمح بقيم مختلفة قابلة للإجابة.",
        "Check selection bounds and number precision; distinct attainable values are required.",
      ),
      WEIGHT_MODE: t(
        "استخدم المتوسط المرجح للأوزان المختلفة، أو أعد الأوزان إلى ١.",
        "Use weighted average for unequal weights, or reset weights to 1.",
      ),
      MIXED_SUM_SCALES: t(
        "يتطلب الجمع نطاقاً مشتركاً؛ استخدم متوسط القيم المعيارية للمقاييس المختلفة.",
        "Sum requires a common scale; use normalized averages for different scales.",
      ),
      BANDS: t(
        "النطاقات يجب أن تغطي ٠–١٠٠ بالترتيب بلا فجوات.",
        "Bands must cover 0–100 in order without gaps.",
      ),
      COVERAGE: t(
        "التغطية أكبر من صفر ولا تتجاوز واحداً.",
        "Coverage must be greater than zero and at most one.",
      ),
      ALL_REQUIRED: t(
        "المجموع والنسبة يتطلبان أسئلة مطلوبة وتغطية كاملة.",
        "Sum and percentage require mandatory items and full coverage.",
      ),
      DENOMINATOR: t(
        "المقام يساوي عدد أسئلة نعم/لا المطلوبة غير المعكوسة.",
        "Denominator must equal the required unreversed yes/no item count.",
      ),
      DIRECTION: t(
        "راجع اتجاه البعد والتحويل الكلي.",
        "Check dimension direction and overall inversion.",
      ),
      UNSCORED: t(
        "أزل مراجع القياس غير المفعلة.",
        "Remove inactive scoring references.",
      ),
      CONTENT_UNSCORED: t(
        "المحتوى لا يتطلب إجابة ولا يدخل القياس.",
        "Content cannot require answers or be scored.",
      ),
      YES_NO_MAPPING: t(
        "نعم/لا يتطلب قيمتي ٠ و١ الثابتتين.",
        "Yes/no requires canonical 0 and 1 mappings.",
      ),
    })[code] ?? t("راجع الحقل المشار إليه.", "Review the referenced field.");
  return (
    <>
      <AppBar
        locale={locale}
        context={t("مكتبة الاستبيانات", "Questionnaire library")}
        meta={<Micro>{org ? "ORG LIBRARY" : "GLOBAL LIBRARY"}</Micro>}
      />
      <main id="main" className="wrap instrument-workspace">
        <PageHeader
          eyebrow={
            <Label accent>
              {org
                ? (organizations.find((o) => o.id === org)?.[
                    locale === "ar" ? "name_ar" : "name_en"
                  ] ?? "")
                : t("مكتبة OrgFit العامة", "OrgFit global library")}
            </Label>
          }
          title={t("مكتبة الاستبيانات", "Questionnaire library")}
        />
        {!ready ? (
          <LoadingState label={t("جارٍ التحميل…", "Loading…")} />
        ) : (
          <>
            {error && (
              <ErrorState
                title={t("تعذّر عرض هذا الجزء", "This section could not be shown")}
                body={error}
              />
            )}
            <ChangeProblem
              locale={locale}
              problem={problem}
              ledger={client.ledger}
              busy={busy}
              onDismiss={() => setProblem(null)}
              testId="questionnaire-problem"
            />
            <p role="status" aria-live="polite">
              {busy ? t("جارٍ الحفظ…", "Saving…") : message}
            </p>
            {/* The checklist is the one place a builder is interrupted:
                a publish is refused until it is empty, so it is an assertive
                alert rather than a polite one. */}
            {!!issues.length && (
              <div className="alert alert-danger stack" role="alert">
                <h2>{t("قائمة التحقق", "Validation checklist")}</h2>
                <ul>
                  {issues.map((x, i) => (
                    <li key={i}>
                      {issueText(x.code)}{" "}
                      <bdi>
                        {doc?.sections
                          .flatMap((s) => [
                            s,
                            ...s.questions,
                            ...s.questions.flatMap((q) => [
                              ...q.options,
                              ...q.rows,
                              ...q.columns,
                            ]),
                          ])
                          .find((n) => x.path.startsWith(n.id))?.id ===
                        x.path ? (
                          <a href={`#item-${x.path}`}>
                            {t("انتقل إلى العنصر", "Go to item")}
                          </a>
                        ) : (
                          <small>{x.path}</small>
                        )}
                      </bdi>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!path.length && (
              <>
                <div className="toolbar">
                <label>
                  {t("نطاق المكتبة", "Library scope")}
                  <select
                    value={org ?? ""}
                    onChange={(e) =>
                      location.assign(
                        `/questionnaires${e.target.value ? `?organization=${e.target.value}` : ""}`,
                      )
                    }
                  >
                    <option value="">
                      {t(
                        "عامة / قوالب توضيحية",
                        "Global / illustrative templates",
                      )}
                    </option>
                    {organizations.map((o) => (
                      <option key={o.id} value={o.id}>
                        {locale === "ar" ? o.name_ar : o.name_en || o.name_ar}
                      </option>
                    ))}
                  </select>
                </label>
                {/* Beneath the organization: disabled until one is chosen, and
                    only that organization's departments are offered. */}
                <label>
                  {t("القسم", "Department")}
                  <select
                    value={departmentFilter}
                    disabled={!org || scopeOptions.loading}
                    data-testid="questionnaire-department-filter"
                    onChange={(e) => {
                      setDepartmentFilter(e.target.value);
                      void loadList(undefined, e.target.value).catch(
                        (x) => !silent(x) && setError(x.message),
                      );
                    }}
                  >
                    <option value="">
                      {org
                        ? t("كل الأقسام", "All departments")
                        : t("اختر منظمة أولاً", "Select an organization first")}
                    </option>
                    {scopeOptions.items.map((d) => (
                      <option key={d.id} value={d.id}>
                        {departmentName(d, locale)}
                        {d.status === "ACTIVE" ? "" : ` (${t("مؤرشف", "archived")})`}
                      </option>
                    ))}
                  </select>
                </label>
                <form
                  className="row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void loadList().catch((e) => setError(e.message));
                  }}
                >
                  <label>
                    {t("بحث", "Search")}
                    <input value={q} onChange={(e) => setQ(e.target.value)} />
                  </label>
                  <label>
                    {t("الحالة", "Status")}
                    <select
                      value={status}
                      onChange={(e) => setStatus(e.target.value)}
                    >
                      <option value="ACTIVE">{t("نشط", "Active")}</option>
                      <option value="ARCHIVED">{t("مؤرشف", "Archived")}</option>
                      <option value="ALL">{t("الكل", "All")}</option>
                    </select>
                  </label>
                  <button className="button-secondary">
                    {t("بحث", "Search")}
                  </button>
                </form>
                {canManage && (
                  <button
                    onClick={() => {
                      setCreating(!creating);
                      setTitle(tr());
                      setCreateOrg(org ?? "");
                      setCreateTarget(entireOrganization);
                    }}
                  >
                    {t("إنشاء استبيان فارغ", "Create blank questionnaire")}
                  </button>
                )}
                </div>
                {creating && (
                  <fieldset disabled={busy} className="stack" data-testid="questionnaire-create">
                    <Translated
                      label={t("عنوان الاستبيان", "Questionnaire title")}
                      value={title}
                      onChange={setTitle}
                    />
                    <label>
                      {t("المنظمة", "Organization")}
                      <select
                        value={createOrg}
                        data-testid="questionnaire-create-organization"
                        onChange={(e) => {
                          setCreateOrg(e.target.value);
                          // Keep the chosen mode but never the departments.
                          setCreateTarget((v) => ({ mode: v.mode, departmentIds: [] }));
                        }}
                      >
                        <option value="">
                          {t("عامة / قوالب توضيحية", "Global / illustrative templates")}
                        </option>
                        {organizations.map((o) => (
                          <option key={o.id} value={o.id}>
                            {organizationName(o, locale)}
                          </option>
                        ))}
                      </select>
                    </label>
                    {createOrg && (
                      <TargetPicker
                        key={createOrg}
                        name="create"
                        t={t}
                        locale={locale}
                        org={createOrg}
                        value={createTarget}
                        onChange={setCreateTarget}
                        options={createOptions}
                      />
                    )}
                    <button
                      type="button"
                      disabled={!!createOrg && !targetComplete(createTarget, createOptions.items)}
                      onClick={() => void create()}
                    >
                      {t("إنشاء", "Create")}
                    </button>
                  </fieldset>
                )}
                {!list.length && !busy && (
                  <EmptyState
                    title={t("لا يوجد شيء هنا بعد", "Nothing here yet")}
                    body={t(
                      "لا توجد استبيانات في هذا النطاق.",
                      "No questionnaires in this scope.",
                    )}
                  />
                )}
                <ul className="plain-list card-list">
                  {list.map((item) => (
                    <li className="card" key={item.id}>
                      <h2>
                        <a href={`/questionnaires/${item.id}${suffix}`}>
                          {locale === "ar"
                            ? item.name_ar
                            : item.name_en || item.name_ar}
                        </a>
                      </h2>
                      {item.source === "BUILTIN" ? (
                        <Badge tone="caution">
                          {t(
                            "قالب توضيحي، غير معتمد علمياً",
                            "Illustrative template, not scientifically validated",
                          )}
                        </Badge>
                      ) : (
                        <Badge tone="neutral">
                          {t("استبيان مخصص", "Custom questionnaire")}
                        </Badge>
                      )}
                      {org && (
                        <TargetSummary t={t} locale={locale} organization={orgLabel(org)} target={item} />
                      )}
                    </li>
                  ))}
                </ul>
                {cursor && (
                  <p>
                    <button
                      className="button-secondary"
                      onClick={() =>
                        void loadList(cursor).catch((e) => setError(e.message))
                      }
                    >
                      {t("عرض المزيد", "Load more")}
                    </button>
                  </p>
                )}
              </>
            )}
            {detail && !version && (
              <>
                <h2>
                  {locale === "ar"
                    ? detail.name_ar
                    : detail.name_en || detail.name_ar}
                </h2>
                {detail.source === "BUILTIN" && (
                  <p>
                    {t(
                      "قالب توضيحي غير معتمد علمياً. افتح النسخة وانسخها للتعديل.",
                      "Illustrative, not scientifically validated. Open a version and clone it to edit.",
                    )}
                  </p>
                )}
                {org && (
                  <TargetSummary t={t} locale={locale} organization={orgLabel(org)} target={detail} />
                )}
                {org &&
                  canManage &&
                  detail.source !== "BUILTIN" &&
                  detail.status === "ACTIVE" && (
                    <details data-testid="questionnaire-target-edit">
                      <summary>{t("تعديل الاستهداف", "Change target")}</summary>
                      <fieldset disabled={busy} className="stack">
                        <p className="muted">
                          {t(
                            "يبقى الاستبيان تابعاً لهذه المنظمة؛ الأقسام تحدد نطاقه داخلها فقط.",
                            "The questionnaire stays with this organization; departments only narrow it within the organization.",
                          )}
                        </p>
                        <TargetPicker
                          name="edit"
                          t={t}
                          locale={locale}
                          org={org}
                          value={editTarget}
                          onChange={(v) => {
                            setEditTarget(v);
                            setTargetDirty(true);
                          }}
                          options={scopeOptions}
                        />
                        <button
                          type="button"
                          disabled={!targetDirty || !targetComplete(editTarget, scopeOptions.items)}
                          onClick={() => void saveTarget()}
                        >
                          {t("حفظ الاستهداف", "Save target")}
                        </button>
                      </fieldset>
                    </details>
                  )}
                <ul>
                  {detail.versions.map((v) => (
                    <li key={v.id}>
                      <a
                        href={`/questionnaires/${detail.id}/versions/${v.id}${suffix}`}
                      >
                        {t("النسخة", "Version")} {v.version_number} ·{" "}
                        {v.state === "DRAFT"
                          ? t("مسودة", "Draft")
                          : v.state === "PUBLISHED"
                            ? t("منشور", "Published")
                            : t("متقاعد", "Retired")}
                      </a>
                    </li>
                  ))}
                </ul>
                {canManage &&
                  detail.source !== "BUILTIN" &&
                  detail.status === "ACTIVE" && (
                    <button
                      disabled={busy}
                      onClick={async () => {
                        const url = `${base}/${detail.id}/archive`;
                        const archiveOnce = async (again: boolean) => {
                          setBusy(true);
                          setProblem(null);
                          try {
                            await api(url, "POST", {}, detail.revision, `POST ${url}`, again);
                            navigateAfterSave(`/questionnaires${suffix}`);
                          } catch (e) {
                            fail(e, `POST ${url}`, () => void archiveOnce(true));
                            setBusy(false);
                          }
                        };
                        await archiveOnce(false);
                      }}
                    >
                      {t("أرشفة الاستبيان", "Archive questionnaire")}
                    </button>
                  )}
              </>
            )}
            {version && doc && (
              <>
                <div className="row">
                  <h2>
                    {t("النسخة", "Version")} {version.version_number} ·{" "}
                    {version.state === "DRAFT"
                      ? t("مسودة", "Draft")
                      : version.state === "PUBLISHED"
                        ? t("منشور وثابت", "Published and immutable")
                        : t("متقاعد", "Retired")}
                  </h2>
                  <a
                    href={`/questionnaires/${version.questionnaire_id}${suffix}`}
                  >
                    {t("كل النسخ", "All versions")}
                  </a>
                </div>
                {org && detail && (
                  <TargetSummary t={t} locale={locale} organization={orgLabel(org)} target={detail} />
                )}
                {detail?.source === "BUILTIN" && (
                  <p>
                    {t(
                      "قالب توضيحي فقط، غير معتمد علمياً.",
                      "Illustrative only, not scientifically validated.",
                    )}
                  </p>
                )}
                <div className="row">
                  {["build", "dimensions", "recommendations", "preview"].map((v, i) => (
                    <button
                      type="button"
                      key={v}
                      aria-pressed={tab === v}
                      onClick={() => setTab(v)}
                    >
                      {
                        [
                          t("بناء الاستبيان", "Build"),
                          t("الأبعاد والتفسير", "Dimensions and bands"),
                          t("قواعد التوصيات", "Recommendation rules"),
                          t("معاينة تجريبية", "Synthetic preview"),
                        ][i]
                      }
                    </button>
                  ))}
                </div>
                {editable && (
                  <div className="row">
                    <button
                      disabled={busy || !dirty}
                      onClick={() => void save()}
                    >
                      {t("حفظ الآن", "Save now")}
                    </button>
                    <button
                      disabled={busy || dirty}
                      onClick={() => void action("validate")}
                    >
                      {t("التحقق للنشر", "Validate for publication")}
                    </button>
                    <button
                      disabled={busy || dirty}
                      onClick={() => void action("publish")}
                    >
                      {t("نشر النسخة وتثبيتها", "Publish and lock version")}
                    </button>
                  </div>
                )}
                {canManage &&
                  detail?.source !== "BUILTIN" &&
                  detail?.status === "ACTIVE" && (
                    <div className="row">
                      <button
                        disabled={busy || dirty}
                        onClick={() => void action("new-version")}
                      >
                        {t(
                          "إنشاء نسخة مسودة جديدة",
                          "Create new draft version",
                        )}
                      </button>
                      {version.state === "PUBLISHED" && (
                        <button
                          disabled={busy}
                          onClick={() => void action("retire")}
                        >
                          {t("تقاعد النسخة", "Retire version")}
                        </button>
                      )}
                    </div>
                  )}
                {tab === "preview" ? (
                  <InstrumentPreview
                    document={doc}
                    pin={{
                      engineVersion: version.engine_version,
                      configVersion:
                        version.state === "DRAFT"
                          ? `draft:${version.version_number}:${version.revision}${dirty ? ":unsaved" : ""}`
                          : version.id,
                    }}
                  />
                ) : (
                  <fieldset
                    disabled={!editable || busy}
                    className="editor-root"
                  >
                    <legend>
                      {tab === "build"
                        ? t("تعريف الاستبيان", "Questionnaire definition")
                        : tab === "recommendations"
                          ? t("قواعد التوصيات", "Recommendation rules")
                          : t("تعريف القياس", "Scoring definition")}
                    </legend>
                    {tab === "recommendations" ? (
                      <RulesEditor d={doc} change={change} t={t} />
                    ) : tab === "dimensions" ? (
                      <DimensionsEditor d={doc} change={change} t={t} />
                    ) : (
                      <div className="stack">
                        <Translated
                          label={t("عنوان الاستبيان", "Questionnaire title")}
                          value={doc.title}
                          onChange={(title) => change({ ...doc, title })}
                        />
                        <Translated
                          label={t("المقدمة", "Introduction")}
                          value={doc.introduction}
                          onChange={(introduction) =>
                            change({ ...doc, introduction })
                          }
                        />
                        <Translated
                          label={t("إشعار الخصوصية", "Privacy notice")}
                          value={doc.privacyText}
                          onChange={(privacyText) =>
                            change({ ...doc, privacyText })
                          }
                        />
                        <label className="choice">
                          <input
                            type="checkbox"
                            checked={doc.locales.includes("en")}
                            onChange={(e) =>
                              change({
                                ...doc,
                                locales: e.target.checked
                                  ? ["ar", "en"]
                                  : ["ar"],
                              })
                            }
                          />
                          {t(
                            "تفعيل الإنجليزية (يلزم اكتمال الترجمة للنشر)",
                            "Enable English (complete translation required for publication)",
                          )}
                        </label>
                        {doc.sections.map((s, i) => (
                          <section
                            className="builder-section"
                            key={s.id}
                            id={`item-${s.id}`}
                          >
                            <h3>
                              {t("القسم", "Section")} {i + 1}
                            </h3>
                            <Translated
                              label={t("عنوان القسم", "Section title")}
                              value={s.title}
                              onChange={(title) =>
                                change({
                                  ...doc,
                                  sections: doc.sections.map((x) =>
                                    x.id === s.id ? { ...x, title } : x,
                                  ),
                                })
                              }
                            />
                            <Translated
                              label={t("محتوى القسم", "Section content")}
                              value={s.content}
                              onChange={(content) =>
                                change({
                                  ...doc,
                                  sections: doc.sections.map((x) =>
                                    x.id === s.id ? { ...x, content } : x,
                                  ),
                                })
                              }
                            />
                            <Order
                              index={i}
                              count={doc.sections.length}
                              t={t}
                              onMove={(by) =>
                                change({
                                  ...doc,
                                  sections: moveItem(doc.sections, i, by),
                                })
                              }
                              onCopy={() =>
                                change({
                                  ...doc,
                                  sections: [...doc.sections, duplicateItem(s)],
                                })
                              }
                              onRemove={() =>
                                change({
                                  ...doc,
                                  sections: doc.sections.filter(
                                    (x) => x.id !== s.id,
                                  ),
                                })
                              }
                            />
                            {s.questions.map((question, j) => (
                              <details
                                className="builder-question"
                                key={question.id}
                                id={`item-${question.id}`}
                                open
                              >
                                <summary>
                                  {j + 1}.{" "}
                                  {question.prompt[locale] ||
                                    labels[
                                      questionTypes.indexOf(question.type)
                                    ]}{" "}
                                  ·{" "}
                                  {labels[questionTypes.indexOf(question.type)]}
                                </summary>
                                <QuestionEditor
                                  q={question}
                                  dimensions={doc.dimensions}
                                  t={t}
                                  change={(q) =>
                                    change({
                                      ...doc,
                                      sections: doc.sections.map((x) =>
                                        x.id === s.id
                                          ? {
                                              ...x,
                                              questions: x.questions.map((y) =>
                                                y.id === q.id ? q : y,
                                              ),
                                            }
                                          : x,
                                      ),
                                    })
                                  }
                                />
                                <Order
                                  index={j}
                                  count={s.questions.length}
                                  t={t}
                                  onMove={(by) =>
                                    change({
                                      ...doc,
                                      sections: doc.sections.map((x) =>
                                        x.id === s.id
                                          ? {
                                              ...x,
                                              questions: moveItem(
                                                x.questions,
                                                j,
                                                by,
                                              ),
                                            }
                                          : x,
                                      ),
                                    })
                                  }
                                  onCopy={() =>
                                    change({
                                      ...doc,
                                      sections: doc.sections.map((x) =>
                                        x.id === s.id
                                          ? {
                                              ...x,
                                              questions: [
                                                ...x.questions,
                                                duplicateItem(question),
                                              ],
                                            }
                                          : x,
                                      ),
                                    })
                                  }
                                  onRemove={() =>
                                    change({
                                      ...doc,
                                      sections: doc.sections.map((x) =>
                                        x.id === s.id
                                          ? {
                                              ...x,
                                              questions: x.questions.filter(
                                                (y) => y.id !== question.id,
                                              ),
                                            }
                                          : x,
                                      ),
                                    })
                                  }
                                />
                              </details>
                            ))}
                            <div className="row">
                              <label>
                                {t("نوع السؤال الجديد", "New question type")}
                                <select
                                  value={newTypes[s.id] ?? "SHORT_TEXT"}
                                  onChange={(e) =>
                                    setNewTypes({
                                      ...newTypes,
                                      [s.id]: e.target.value as QuestionType,
                                    })
                                  }
                                >
                                  {questionTypes.map((v, k) => (
                                    <option key={v} value={v}>
                                      {labels[k]}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <button
                                type="button"
                                onClick={() =>
                                  change({
                                    ...doc,
                                    sections: doc.sections.map((x) =>
                                      x.id === s.id
                                        ? {
                                            ...x,
                                            questions: [
                                              ...x.questions,
                                              newQuestion(
                                                newTypes[s.id] ?? "SHORT_TEXT",
                                              ),
                                            ],
                                          }
                                        : x,
                                    ),
                                  })
                                }
                              >
                                {t("إضافة سؤال", "Add question")}
                              </button>
                            </div>
                          </section>
                        ))}
                        <button
                          type="button"
                          onClick={() =>
                            change({
                              ...doc,
                              sections: [
                                ...doc.sections,
                                {
                                  ...newIdentity(),
                                  title: tr(),
                                  content: tr(),
                                  questions: [],
                                },
                              ],
                            })
                          }
                        >
                          {t("إضافة قسم", "Add section")}
                        </button>
                      </div>
                    )}
                  </fieldset>
                )}
                {canManage && (
                  <details>
                    <summary>
                      {t(
                        "نسخ إلى استبيان مخصص مستقل",
                        "Clone into a separate custom questionnaire",
                      )}
                    </summary>
                    <fieldset disabled={busy || dirty}>
                      <Translated
                        label={t(
                          "عنوان النسخة المخصصة",
                          "Custom questionnaire title",
                        )}
                        value={title}
                        onChange={setTitle}
                      />
                      <label>
                        {t("نطاق النسخة", "Destination scope")}
                        <select
                          value={cloneTarget}
                          onChange={(e) => {
                            setCloneTarget(e.target.value);
                            setCloneTargetValue((v) => ({ mode: v.mode, departmentIds: [] }));
                          }}
                        >
                          {!org && (
                            <option value="">{t("عامة", "Global")}</option>
                          )}
                          {organizations
                            .filter((o) => !org || o.id === org)
                            .map((o) => (
                              <option key={o.id} value={o.id}>
                                {locale === "ar"
                                  ? o.name_ar
                                  : o.name_en || o.name_ar}
                              </option>
                            ))}
                        </select>
                      </label>
                      {cloneTarget && (
                        <TargetPicker
                          key={cloneTarget}
                          name="clone"
                          t={t}
                          locale={locale}
                          org={cloneTarget}
                          value={cloneTargetValue}
                          onChange={setCloneTargetValue}
                          options={cloneOptions}
                        />
                      )}
                      <button
                        type="button"
                        disabled={!!cloneTarget && !targetComplete(cloneTargetValue, cloneOptions.items)}
                        onClick={() => void create(true)}
                      >
                        {t("إنشاء نسخة مخصصة", "Create custom copy")}
                      </button>
                    </fieldset>
                  </details>
                )}
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}
