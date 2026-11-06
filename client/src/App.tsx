import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, Route, Routes, useSearchParams } from 'react-router-dom';
import { getToken, setToken, useApi } from './api';
import Compare from './pages/Compare';
import Events from './pages/Events';
import NotFound from './pages/NotFound';
import Quality from './pages/Quality';
import Sources from './pages/Sources';

export const RANGES = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
  { days: 180, label: 'Last 180 days' },
] as const;

/** Reads ?days= from the URL. The range is always "the last N days up to now". */
export function useDays(): [number, (d: number) => void] {
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get('days'));
  const days = RANGES.some((r) => r.days === raw) ? raw : 30;
  const set = (d: number) => {
    const next = new URLSearchParams(params);
    next.set('days', String(d));
    setParams(next, { replace: true });
  };
  return [days, set];
}

/** Query string for the API, rounded to the minute so repeated renders hit the same URL. */
export function rangeQuery(days: number): string {
  const to = new Date(Math.ceil(Date.now() / 60_000) * 60_000);
  const from = new Date(to.getTime() - days * 24 * 3600 * 1000);
  return `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
}

function RangePicker() {
  const [days, setDays] = useDays();
  return (
    <div className="rail-group rail-range" role="group" aria-label="Date range">
      <p className="rail-heading">Range</p>
      {RANGES.map((r) => (
        <button key={r.days} type="button" aria-pressed={days === r.days} onClick={() => setDays(r.days)}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

function TokenGate() {
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setToken(value.trim());
  };
  return (
    <main className="page narrow">
      <p className="wordmark">
        <span className="blaze" aria-hidden="true" />
        Trailmark
      </p>
      <form onSubmit={submit} className="token-form">
        <label htmlFor="token">Access token</label>
        <input id="token" type="password" autoComplete="current-password" value={value} onChange={(e) => setValue(e.target.value)} />
        <button className="btn" type="submit" disabled={!value.trim()}>
          Open dashboard
        </button>
      </form>
      <p className="small" style={{ marginTop: 12 }}>
        This is the DASHBOARD_TOKEN value set on the server.
      </p>
      {getToken() && (
        <p className="alert" role="alert">
          That token was not accepted. Check it against DASHBOARD_TOKEN and try again.
        </p>
      )}
    </main>
  );
}

function NavItem({ to, children }: { to: string; children: ReactNode }) {
  const [params] = useSearchParams();
  const days = params.get('days');
  return (
    <NavLink to={days ? `${to}?days=${days}` : to} end>
      {children}
    </NavLink>
  );
}

export default function App() {
  const config = useApi<{ engine: string; gaConfigured: boolean }>('/api/config');

  if (config.error?.status === 401) return <TokenGate />;

  return (
    <div className="shell">
      <aside className="rail">
        <Link to="/" className="wordmark">
          <span className="blaze" aria-hidden="true" />
          Trailmark
        </Link>
        <nav className="rail-group" aria-label="Main">
          <NavItem to="/">Sources</NavItem>
          <NavItem to="/events">Events</NavItem>
          <NavItem to="/quality">Data quality</NavItem>
          <NavItem to="/google-analytics">Google Analytics</NavItem>
        </nav>
        <RangePicker />
        <div className="rail-foot">
          <p>Tracking Shoebox</p>
          {getToken() && (
            <button type="button" onClick={() => setToken('')}>
              Sign out
            </button>
          )}
        </div>
      </aside>
      <div>
        {config.error && config.error.status !== 401 && (
          <p className="alert" role="alert" style={{ margin: '24px 48px 0' }}>
            Can't reach the Trailmark server: {config.error.message}
          </p>
        )}
        <Routes>
          <Route path="/" element={<Sources />} />
          <Route path="/events" element={<Events />} />
          <Route path="/quality" element={<Quality />} />
          <Route path="/google-analytics" element={<Compare configured={config.data?.gaConfigured ?? false} />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </div>
    </div>
  );
}
