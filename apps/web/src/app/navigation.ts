import {
  ArrowRightLeft,
  Cloud,
  Database,
  FolderSync,
  LayoutDashboard,
  LifeBuoy,
  ListChecks,
  ScrollText,
  Settings,
  type LucideIcon,
} from 'lucide-react';

export type NavigationItem = {
  label: string;
  path: string;
  icon: LucideIcon;
  /** One line naming what the route answers; shown in the command palette. */
  hint: string;
};

/**
 * The routes, in the order an operator works through them: what is happening
 * now, what could be moved, what is coming in from a netdisk, what is moving out,
 * what came back, and then the three surfaces that exist to be checked rather
 * than acted on.
 *
 * Netdisk imports sit next to torrents rather than inside `/transfers`: both
 * pages move bytes to the same cloud, but a transfer is identified by
 * `(instanceId, torrentHash)` and an import has no torrent at all.
 *
 * Single source for the rail, the router's fallback routes and the palette, so
 * a page can never appear in one and be missing from another.
 */
export const navigationItems: readonly NavigationItem[] = [
  { label: '仪表盘', path: '/', icon: LayoutDashboard, hint: '总览' },
  { label: '种子', path: '/torrents', icon: ListChecks, hint: '库存' },
  { label: '网盘迁移', path: '/imports', icon: FolderSync, hint: '导入与发布' },
  { label: '传输', path: '/transfers', icon: ArrowRightLeft, hint: '任务' },
  { label: '云端媒体', path: '/media', icon: Cloud, hint: '播放与回迁' },
  { label: '存储账户', path: '/storage-accounts', icon: Database, hint: '容量' },
  { label: '恢复', path: '/recovery', icon: LifeBuoy, hint: '删除门' },
  { label: '审计', path: '/audit', icon: ScrollText, hint: '记录' },
  { label: '设置', path: '/settings', icon: Settings, hint: '连接' },
] as const;
