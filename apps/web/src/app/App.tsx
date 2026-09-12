import { KeyRound, Compass, Dot } from 'lucide-react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { DashboardPage } from '../features/dashboard/DashboardPage.js';
import { TorrentsPage } from '../features/torrents/TorrentsPage.js';
import { ImportsPage } from '../features/imports/ImportsPage.js';
import { JobsPage } from '../features/jobs/JobsPage.js';
import { AccountsPage } from '../features/storage/AccountsPage.js';
import { RecoveryPage } from '../features/recovery/RecoveryPage.js';
import { LoginPage } from '../features/auth/LoginPage.js';
import { BootstrapPage } from '../features/onboarding/BootstrapPage.js';
import { SetupPage } from '../features/onboarding/SetupPage.js';
import { MfaPage } from '../features/auth/MfaPage.js';
import { returnToFromState } from '../features/auth/sessionLifecycle.js';
import { MediaPage } from '../features/media/MediaPage.js';
import { AuditPage } from '../features/audit/AuditPage.js';
import { NetdiskSettingsPage } from '../features/settings/NetdiskSettingsPage.js';
import { SettingsPage } from '../features/settings/SettingsPage.js';
import { ProtectedRoute } from './ProtectedRoute.js';
import { navigationItems } from './navigation.js';
import { Shell } from './Shell.js';

function RecoveryCodePage() {
  const location = useLocation();
  const returnTo = returnToFromState(location.state);

  return (
    <main className="auth-page">
      <section className="auth-panel" aria-labelledby="recovery-title">
        <div className="auth-brand" aria-label="PT Cloud Vault">
          <span className="brand-mark" aria-hidden="true">
            <KeyRound size={18} strokeWidth={1.8} />
          </span>
          <span>PT Cloud Vault</span>
        </div>
        <header className="auth-heading">
          <h1 id="recovery-title">恢复码登录</h1>
          <p>恢复码登录暂未开放。</p>
        </header>
        <div className="auth-actions auth-actions-single">
          <Link to="/login" state={returnTo ? { returnTo } : undefined} aria-label="Back to login">
            返回登录
          </Link>
        </div>
      </section>
    </main>
  );
}

/**
 * A rail entry that has no surface yet.
 *
 * Nothing routes here today — every item in `navigationItems` has a page. It
 * stays as the fallback because the rail and the router read from the same list:
 * without it, adding an entry and forgetting its route would send the operator
 * to the dashboard with no indication that anything was missing. An empty frame
 * on an operations console reads as a failed request, so it names the gap
 * instead of showing one.
 */
function StubPage({ title }: { title: string }) {
  return (
    <section className="content-page" aria-labelledby="empty-page-title">
      <header className="page-header">
        <div>
          <p className="page-kicker">运维</p>
          <h1 id="empty-page-title">{title}</h1>
        </div>
      </header>
      <div className="stub-page">
        <span className="stub-glyph" aria-hidden="true">
          <Compass size={24} strokeWidth={1.6} />
        </span>
        <h2>这一页还没有建，不是加载失败。</h2>
        <p>
          左侧其余入口都是可用的。连接与容量策略在<Link to="/settings">设置</Link>
          ，云端账户容量在<Link to="/storage-accounts">存储账户</Link>。
        </p>
        <ul className="stub-list">
          <li>
            <Dot size={16} strokeWidth={3} aria-hidden="true" />
            <span>导航栏与路由表读的是同一份清单，所以这一页只会在新入口刚加上时出现。</span>
          </li>
        </ul>
      </div>
    </section>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<BootstrapPage />} />
      <Route path="/login/mfa" element={<MfaPage />} />
      <Route path="/login/recovery" element={<RecoveryCodePage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<Shell />}>
          <Route index element={<DashboardPage />} />
          <Route path="torrents" element={<TorrentsPage />} />
          <Route path="imports" element={<ImportsPage />} />
          <Route path="transfers" element={<JobsPage />} />
          <Route path="storage-accounts" element={<AccountsPage />} />
          <Route path="recovery" element={<RecoveryPage />} />
          <Route path="media" element={<MediaPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="settings" element={<SettingsPage />} />
          {/*
            A child of `settings`, not a tenth rail entry.

            The netdisk track has its own runtime, its own source accounts and its
            own safety gates, so its settings need a page rather than another card
            on the qB scheduler. Nesting keeps the rail at nine and lets the rail's
             「设置」 entry stay marked while this page is open — a fourth top-level
            item would put a settings page beside its own parent.
          */}
          <Route path="settings/netdisk" element={<NetdiskSettingsPage />} />
          <Route path="settings/setup" element={<SetupPage />} />
          {navigationItems
            .filter(
              ({ path }) =>
                ![
                  '/',
                  '/torrents',
                  '/imports',
                  '/transfers',
                  '/storage-accounts',
                  '/recovery',
                  '/media',
                  '/audit',
                  '/settings',
                ].includes(path),
            )
            .map(({ label, path }) => (
              <Route key={path} path={path.slice(1)} element={<StubPage title={label} />} />
            ))}
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
