/* Full document navigation intentionally clears organization-scoped client state. */
// ---------------------------------------------------------------------------
// The public overview page.
//
// This is the only page in the product that is readable without a session, and
// it is deliberately inert: it reads no database, holds no credential, calls
// readConfig() nowhere and renders the same bytes for everyone. Protecting the
// internal pages and the API is done where it was always done — access.actor()
// and withStaff — and nothing here participates in that.
//
// The copy lives in src/landing-i18n.ts, which carries the two content rules
// this page is held to: no capability that is not implemented, and no privacy
// claim beyond the implemented model. Read that file's header before changing
// a word of what is rendered below.
// ---------------------------------------------------------------------------

import { cookies } from "next/headers";
import { direction, localeOf, messages } from "../../../src/i18n";
import { landing } from "../../../src/landing-i18n";
import { Mark } from "../../../src/ui";
import "../../../src/landing.css";
import { SiteHeader, LanguageSwitch } from "./landing-ui";
import {
  IconAggregate,
  IconAnalysis,
  IconCampaign,
  IconDisclose,
  IconInstrument,
  IconReport,
  IconRule,
  IconSeparation,
  IconThreshold,
  ParticipationFigure,
  RecommendationFigure,
  ResultsFigure,
  RoundFigure,
  StructureFigure,
} from "./figures";

export const metadata = {
  title: "OrgFit",
  // The overview page describes an internal platform. It is not published
  // anywhere and must not be indexed if this origin is ever reachable.
  robots: { index: false, follow: false },
};

export default async function Overview() {
  const locale = localeOf((await cookies()).get("orgfit-locale")?.value);
  const rtl = direction(locale) === "rtl";
  const m = messages(locale);
  const c = landing(locale);

  // The five capabilities that follow the lead one, each with its drawn mark.
  const rest = c.capabilities.slice(1);
  const capabilityIcons = [
    IconInstrument,
    IconCampaign,
    IconAnalysis,
    IconRule,
    IconReport,
  ];
  const privacyIcons = [IconSeparation, IconAggregate, IconThreshold];
  const panelFigures = [ResultsFigure, ParticipationFigure, RecommendationFigure];

  return (
    <div className="landing">
      <SiteHeader locale={locale} />
      <main id="main">
        {/* ---------------------------------------------------------- hero */}
        <section className="hero" id="overview">
          <div className="hero-inner">
            <div className="hero-copy">
              <h1>{c.heroHeadline}</h1>
              <p className="hero-lede">{c.heroBody}</p>
              <div className="hero-actions">
                <a className="button" href="/login">
                  {c.signIn}
                </a>
                <a className="button button-secondary" href="#capabilities">
                  {c.heroSecondary}
                </a>
              </div>
              <p className="hero-note">{c.heroNote}</p>
            </div>
            <div className="hero-figure figure">
              <div className="figure-head">
                <span className="figure-title">{c.previewTitle}</span>
                <span className="figure-synthetic">
                  <span aria-hidden="true">◆</span>
                  {c.previewSynthetic}
                </span>
              </div>
              <div className="figure-body">
                <RoundFigure copy={c} rtl={rtl} />
                <p className="figure-note">
                  <span className="figure-note-glyph" aria-hidden="true">
                    ▨
                  </span>
                  {c.previewWithheldNote}
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* -------------------------------------------------- capabilities */}
        <section className="section" id="capabilities">
          <div className="section-head">
            <h2>{c.capabilitiesTitle}</h2>
            <p>{c.capabilitiesLead}</p>
          </div>

          <div className="cap-lead">
            <div>
              <h3>{c.capabilities[0].title}</h3>
              <p>{c.capabilities[0].body}</p>
            </div>
            <div className="figure">
              <div className="figure-body">
                <StructureFigure rtl={rtl} />
              </div>
            </div>
          </div>

          <div className="cap-list">
            {rest.map((capability, i) => {
              const Glyph = capabilityIcons[i];
              return (
                <article className="cap-item" key={capability.title}>
                  <Glyph className="cap-glyph" />
                  <h3>{capability.title}</h3>
                  <p>{capability.body}</p>
                </article>
              );
            })}
          </div>
        </section>

        {/* ------------------------------------------------------ workflow */}
        <section className="section" id="workflow">
          <div className="section-head">
            <h2>{c.workflowTitle}</h2>
            <p>{c.workflowLead}</p>
          </div>
          <ol className="flow">
            {c.workflow.map((step, i) => (
              <li key={step.title}>
                <span className="flow-step" aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* ------------------------------------------------------- privacy */}
        <div className="band-ink">
          <section className="section">
            <div className="section-head">
              <h2>{c.privacyTitle}</h2>
              <p>{c.privacyLead}</p>
            </div>
            <ul className="privacy-points">
              {c.privacyPoints.map((point, i) => {
                const Glyph = privacyIcons[i];
                return (
                  <li key={point.title}>
                    <Glyph className="privacy-glyph" />
                    <h3>{point.title}</h3>
                    <p>{point.body}</p>
                  </li>
                );
              })}
            </ul>
            <p className="privacy-limit">{c.privacyLimit}</p>
          </section>
        </div>

        {/* ------------------------------------------------ product panels */}
        <section className="section">
          <div className="section-head">
            <h2>{c.productTitle}</h2>
            <p>{c.productLead}</p>
          </div>
          <div className="panels">
            {c.productPanels.map((panel, i) => {
              const Figure = panelFigures[i];
              return (
                <article className="panel-figure" key={panel.title}>
                  <div className="figure">
                    <div className="figure-body">
                      <Figure rtl={rtl} />
                    </div>
                  </div>
                  <span className="panel-caption">
                    <span aria-hidden="true">◆</span>
                    {panel.caption}
                  </span>
                  <h3>{panel.title}</h3>
                  <p>{panel.body}</p>
                </article>
              );
            })}
          </div>
        </section>

        {/* ----------------------------------------------------------- faq */}
        <section className="section" id="faq">
          <div className="section-head">
            <h2>{c.faqTitle}</h2>
          </div>
          <div className="faq">
            {c.faq.map((entry) => (
              <details className="faq-item" key={entry.q}>
                <summary>
                  {entry.q}
                  <IconDisclose className="faq-marker" />
                </summary>
                <p className="faq-answer">{entry.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------ closing action */}
        <section className="closing">
          <div className="closing-inner">
            <h2>{c.ctaTitle}</h2>
            <p>{c.ctaBody}</p>
            <a className="button" href="/login">
              {c.signIn}
            </a>
            <p className="field-hint">{c.ctaNote}</p>
          </div>
        </section>
      </main>

      {/* ------------------------------------------------------------ foot */}
      <footer className="site-footer">
        <div className="site-footer-inner">
          <div className="footer-brand">
            <span className="lockup" role="img" aria-label={m.title}>
              <Mark tone="inverse" className="site-brand-mark" />
              <span className="site-brand-text" aria-hidden="true">
                <span className="site-brand-word">ORGFIT</span>
                <span className="site-brand-descriptor">
                  {locale === "en" ? "Organizational assessment" : "التقييم التنظيمي"}
                </span>
              </span>
            </span>
            <p>{c.footerDescription}</p>
            <LanguageSwitch locale={locale} />
          </div>
          <nav aria-label={c.footerSections}>
            <ul className="footer-links">
              <li>
                <a href="#overview">{c.navOverview}</a>
              </li>
              <li>
                <a href="#capabilities">{c.navCapabilities}</a>
              </li>
              <li>
                <a href="#workflow">{c.navWorkflow}</a>
              </li>
              <li>
                <a href="#faq">{c.navFaq}</a>
              </li>
              <li>
                <a href="/login">{c.signIn}</a>
              </li>
            </ul>
          </nav>
          {/* Only links that go somewhere. There is no privacy policy page, no
              help centre and no contact address, because none of those exists;
              inventing one would be inventing a commitment. */}
          <div className="footer-rule">
            <p className="footer-note">{c.footerInternal}</p>
            <p className="footer-note">{c.footerRespondent}</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
