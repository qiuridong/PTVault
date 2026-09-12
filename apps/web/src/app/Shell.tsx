import { useQueryClient } from '@tanstack/react-query';
import {
  Command,
  HardDrive,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Sun,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { ApiError } from '../api/client.js';
import { logout } from '../features/auth/authApi.js';
import { endBrowserSession } from '../features/auth/sessionLifecycle.js';
import {
  applyThemePreference,
  readStoredTheme,
  writeStoredTheme,
  type ThemePreference,
} from '../theme/theme.js';
import { CommandPalette } from './CommandPalette.js';
import { navigationItems } from './navigation.js';

export { navigationItems } from './navigation.js';
export type { NavigationItem } from './navigation.js';

const themeOptions: ReadonlyArray<{
  value: ThemePreference;
  label: string;
  icon: LucideIcon;
}> = [
  { value: 'light', label: '浅色主题', icon: Sun },
  { value: 'dark', label: '深色主题', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
];

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = (): void => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);

  return matches;
}

function ThemeControl() {
  const [theme, setTheme] = useState<ThemePreference>(readStoredTheme);

  useEffect(() => {
    const system = window.matchMedia('(prefers-color-scheme: dark)');
    writeStoredTheme(theme);
    const apply = (): void => {
      applyThemePreference(theme, system.matches);
    };
    apply();
    if (theme === 'system') system.addEventListener('change', apply);
    return () => system.removeEventListener('change', apply);
  }, [theme]);

  return (
    <div className="theme-control" role="group" aria-label="主题外观">
      {themeOptions.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          className="theme-option"
          aria-label={label}
          aria-pressed={theme === value}
          title={label}
          onClick={() => setTheme(value)}
        >
          <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

type ShellProps = {
  children?: ReactNode;
};

export function Shell({ children }: ShellProps) {
  const isDesktop = useMediaQuery('(min-width: 900px)');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [logoutError, setLogoutError] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (isDesktop) setDrawerOpen(false);
  }, [isDesktop]);

  // Ctrl/Cmd+K anywhere. Bound on the document rather than on the rail so it
  // works while the operator is reading a table three screens down.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setPaletteOpen((open) => !open);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (isDesktop || !drawerOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setDrawerOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = sidebarRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      openButtonRef.current?.focus();
    };
  }, [drawerOpen, isDesktop]);

  const signOut = async (): Promise<void> => {
    if (isLoggingOut) return;
    setLogoutError(false);
    setIsLoggingOut(true);
    try {
      await logout();
      endBrowserSession(queryClient, navigate);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        endBrowserSession(queryClient, navigate);
        return;
      }
      setLogoutError(true);
    } finally {
      setIsLoggingOut(false);
    }
  };

  const closeOnLink = (): void => {
    if (!isDesktop) setDrawerOpen(false);
  };

  const handleSidebarKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!isDesktop && event.key === 'Escape') setDrawerOpen(false);
  };

  const mobileHidden = !isDesktop && !drawerOpen;
  const backgroundHidden = !isDesktop && drawerOpen;

  return (
    <div className="app-shell">
      {/* Inert, painted once, never re-laid-out: scrolling a long table must not
          pay for the atmosphere behind it. */}
      <div className="app-atmosphere" aria-hidden="true" />

      <a
        className="skip-link"
        href="#main-content"
        aria-hidden={backgroundHidden || undefined}
        inert={backgroundHidden}
      >
        跳到主要内容
      </a>

      {!isDesktop ? (
        <header
          className="mobile-header"
          aria-hidden={backgroundHidden || undefined}
          inert={backgroundHidden}
        >
          <button
            ref={openButtonRef}
            className="icon-button"
            type="button"
            aria-label="打开导航"
            title="打开导航"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            <Menu size={20} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <span className="mobile-brand">PT Cloud Vault</span>
          <span className="mobile-header-spacer" aria-hidden="true" />
        </header>
      ) : null}

      {!isDesktop && drawerOpen ? (
        <button
          className="drawer-overlay"
          type="button"
          aria-label="关闭导航遮罩"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => setDrawerOpen(false)}
        />
      ) : null}

      <aside
        ref={sidebarRef}
        className={`app-sidebar${drawerOpen ? ' drawer-open' : ''}`}
        role={isDesktop ? undefined : 'dialog'}
        aria-label={isDesktop ? undefined : '主导航'}
        aria-modal={isDesktop ? undefined : true}
        aria-hidden={mobileHidden || undefined}
        inert={mobileHidden}
        onKeyDown={handleSidebarKeyDown}
      >
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <span className="sidebar-brand-mark" aria-hidden="true">
              <HardDrive size={19} strokeWidth={1.8} />
            </span>
            <span>
              <strong>PT Cloud Vault</strong>
              <small>运维台</small>
            </span>
          </div>
          {!isDesktop ? (
            <button
              ref={closeButtonRef}
              className="icon-button"
              type="button"
              aria-label="关闭导航"
              title="关闭导航"
              onClick={() => setDrawerOpen(false)}
            >
              <X size={20} strokeWidth={1.8} aria-hidden="true" />
            </button>
          ) : null}
        </div>

        <nav className="primary-navigation" aria-label="主导航菜单">
          {navigationItems.map(({ label, path, icon: Icon }, index) => (
            <NavLink
              key={path}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              to={path}
              end={path === '/'}
              onClick={closeOnLink}
            >
              <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
              <span className="nav-link-label">{label}</span>
              {/* Positional index, not a count: it gives the rail a rhythm and
                  gives a spoken description something to anchor on. */}
              <span className="nav-link-index" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
            </NavLink>
          ))}
        </nav>

        <footer className="sidebar-footer">
          {/* No `aria-label`: the accessible name is the visible text, so a voice
              user can say what they read. The shortcut is announced with it. */}
          <button className="command-hint" type="button" onClick={() => setPaletteOpen(true)}>
            <Command size={15} strokeWidth={1.8} aria-hidden="true" />
            <span>跳转到…</span>
            <kbd>Ctrl K</kbd>
          </button>
          <ThemeControl />
          {logoutError ? (
            <p className="sidebar-error" role="alert">
              退出登录失败。
            </p>
          ) : null}
          <button
            className="signout-button"
            type="button"
            disabled={isLoggingOut}
            onClick={() => void signOut()}
          >
            <LogOut size={17} strokeWidth={1.8} aria-hidden="true" />
            <span>{isLoggingOut ? '退出中…' : '退出登录'}</span>
          </button>
        </footer>
      </aside>

      <main
        className="app-main"
        id="main-content"
        tabIndex={-1}
        aria-hidden={backgroundHidden || undefined}
        inert={backgroundHidden}
      >
        {new URLSearchParams(location.search).get('from') === 'setup' && <Link className="ghost-button setup-return" to="/settings/setup">返回首次设置，查看下一步</Link>}
        {children ?? <Outlet />}
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
