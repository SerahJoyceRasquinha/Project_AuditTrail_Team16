import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

const capabilities = [
  {
    index: '01',
    title: 'Immutable history',
    text: 'Every shipment change is preserved as an append-only event chain with versioning and hash links.',
    tone: 'teal',
  },
  {
    index: '02',
    title: 'Reconstruct any moment',
    text: 'Move through the timeline and replay state exactly as it existed at a point in transit.',
    tone: 'violet',
  },
  {
    index: '03',
    title: 'Catch cold-chain drift',
    text: 'Pair sensor readings with operational events so temperature excursions never disappear in a summary.',
    tone: 'amber',
  },
];

export function LandingPage() {
  const { isAuthenticated } = useAuth();

  return (
    <div className="landing">
      <section className="landing__hero" aria-labelledby="landing-title">
        <div className="landing__hero-copy">
          <p className="eyebrow landing__eyebrow"><span className="status-light" /> Event-sourced logistics ledger</p>
          <h1 id="landing-title">A shipment’s story,<br /><em>without the gaps.</em></h1>
          <p className="landing__lede">
            Audit Trail turns every container movement and sensor signal into a traceable record you can verify, replay, and understand.
          </p>
          {/*
            Signed out, the two things a visitor can actually do are create an
            account and sign in - so those are the two things offered, rather
            than a ledger link that would only redirect them to the login page.
          */}
          <div className="landing__actions">
            {isAuthenticated ? (
              <Link to="/shipments" className="btn btn--primary landing__primary">Open shipment ledger <span aria-hidden="true">↗</span></Link>
            ) : (
              <>
                <Link to="/register" className="btn btn--primary landing__primary">Create account <span aria-hidden="true">↗</span></Link>
                <Link to="/login" className="btn btn--ghost landing__primary">Sign in</Link>
              </>
            )}
            <a href="#how-it-works" className="btn btn--ghost">See how it works <span aria-hidden="true">↓</span></a>
          </div>
          <div className="landing__proof mono">
            <span><b>EVENTS</b> append-only</span>
            <span><b>STATE</b> replayable</span>
            <span><b>READ MODEL</b> rebuildable</span>
          </div>
        </div>

        <div className="ledger-preview" aria-label="Illustration of a verified event chain">
          <div className="ledger-preview__top"><span>LIVE / AUDIT STREAM</span><span className="ledger-preview__live">● CURRENT</span></div>
          <div className="ledger-preview__route"><span className="mono">SHP-1001</span><span className="route-line" /><span className="mono">IN TRANSIT</span></div>
          <div className="ledger-preview__events">
            <div className="preview-event preview-event--done"><span className="preview-event__dot" /><div><strong>Container created</strong><small>v01 · Chennai · 08:42:10</small></div><span className="preview-event__hash">a7f2...91c</span></div>
            <div className="preview-event preview-event--done"><span className="preview-event__dot" /><div><strong>Loaded on ship</strong><small>v02 · MV Ganges Star · 11:06:44</small></div><span className="preview-event__hash">b4e8...2aa</span></div>
            <div className="preview-event preview-event--alert"><span className="preview-event__dot" /><div><strong>Temperature spike</strong><small>v03 · 12.4°C · threshold 8°C</small></div><span className="pill pill--amber">Breach</span></div>
          </div>
          <div className="ledger-preview__footer"><span>CHAIN INTEGRITY</span><strong>VERIFIED <span aria-hidden="true">✓</span></strong></div>
        </div>
      </section>

      <section className="landing__capabilities" id="how-it-works" aria-labelledby="capabilities-title">
        <div className="section-intro"><p className="eyebrow">One record. Every truth.</p><h2 id="capabilities-title">Built for the moment<br />someone asks, “what happened?”</h2></div>
        <div className="capability-grid">
          {capabilities.map((capability) => (
            <article className={`capability capability--${capability.tone}`} key={capability.index}>
              <span className="capability__index mono">{capability.index}</span>
              <h3>{capability.title}</h3>
              <p>{capability.text}</p>
              <span className="capability__rule" />
            </article>
          ))}
        </div>
      </section>

      <section className="landing__cta">
        <p className="eyebrow">The ledger is ready</p>
        <h2>Start with a shipment.<br /><span>Follow the evidence.</span></h2>
        {isAuthenticated ? (
          <Link to="/shipments" className="btn btn--primary">Browse live records <span aria-hidden="true">↗</span></Link>
        ) : (
          <div className="landing__actions landing__actions--centred">
            <Link to="/register" className="btn btn--primary">Create account <span aria-hidden="true">↗</span></Link>
            <Link to="/login" className="btn btn--ghost">Sign in</Link>
          </div>
        )}
      </section>
    </div>
  );
}
