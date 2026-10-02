/**
 * 权限工具：菜单级 / 操作级鉴权。
 *
 * 后端可用权限码（src 内以常量形式集中管理，避免手写字符串出错）：
 *   menu:dashboard, dashboard:view,
 *   menu:chat,      ai:chat,
 *   menu:knowledge, knowledge:view, knowledge:upload, knowledge:manage, knowledge:grant,
 *   menu:sedimentation, faq:manage, gap:manage,
 *   menu:system,    system:manage
 */
import type { UserProfile } from '@/lib/api';
import type { IconName } from '@/components/Icons';

/** 与后端 seed 完全一致的权限码常量表。 */
export const PERMISSIONS = {
  MENU_DASHBOARD: 'menu:dashboard',
  DASHBOARD_VIEW: 'dashboard:view',
  MENU_CHAT: 'menu:chat',
  AI_CHAT: 'ai:chat',
  MENU_KNOWLEDGE: 'menu:knowledge',
  KNOWLEDGE_VIEW: 'knowledge:view',
  KNOWLEDGE_UPLOAD: 'knowledge:upload',
  KNOWLEDGE_MANAGE: 'knowledge:manage',
  KNOWLEDGE_GRANT: 'knowledge:grant',
  MENU_SEDIMENTATION: 'menu:sedimentation',
  FAQ_MANAGE: 'faq:manage',
  GAP_MANAGE: 'gap:manage',
  MENU_SYSTEM: 'menu:system',
  SYSTEM_MANAGE: 'system:manage',
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * 单点权限判定。
 * - 超级管理员直接放行（与后端 is_superuser 语义一致）
 * - 其余按 permissions 数组精确匹配
 * - 兼容 "资源:*" 形式的前缀通配（后端未来扩展时无需改前端）
 */
export function hasPermission(
  user: UserProfile | null | undefined,
  code: string | null | undefined,
): boolean {
  if (!user || !code) return false;
  if (user.is_superuser) return true;
  const permissions = user.permissions ?? [];
  if (permissions.includes(code)) return true;
  return permissions.some((item) => item.endsWith(':*') && code.startsWith(item.slice(0, -1)));
}

/** 任一权限满足即放行（用于"或"语义的按钮/菜单）。 */
export function hasAnyPermission(
  user: UserProfile | null | undefined,
  codes: readonly string[],
): boolean {
  if (!user) return false;
  if (user.is_superuser) return true;
  return codes.some((code) => hasPermission(user, code));
}

/** 全部权限满足才放行（用于"与"语义）。 */
export function hasAllPermissions(
  user: UserProfile | null | undefined,
  codes: readonly string[],
): boolean {
  if (!user) return false;
  if (user.is_superuser) return true;
  return codes.every((code) => hasPermission(user, code));
}

/* ------------------------------------------------------------------ */
/* 菜单定义表                                                          */
/* ------------------------------------------------------------------ */

export interface MenuItem {
  /** 菜单级权限码（主判定依据）。 */
  code: string;
  label: string;
  href: string;
  description: string;
  icon: IconName;
  /**
   * 兜底权限码：当后端只下发了操作权限、未下发菜单权限时仍能显示菜单，
   * 避免"有操作权限却看不到入口"。
   */
  fallbackCodes?: readonly string[];
}

/**
 * 控制台左侧菜单。
 * 注意：/knowledge、/sedimentation、/system 三个页面由另一位代理实现，
 * 这里先登记菜单与权限码，页面就绪后即可直接跳转。
 */
export const MENU_ITEMS: readonly MenuItem[] = [
  {
    code: PERMISSIONS.MENU_DASHBOARD,
    label: '运营看板',
    href: '/dashboard',
    description: 'PV/UV、知识量、Token 与延时大盘',
    icon: 'dashboard',
    fallbackCodes: [PERMISSIONS.DASHBOARD_VIEW],
  },
  {
    code: PERMISSIONS.MENU_CHAT,
    label: 'AI 智能问答',
    href: '/chat',
    description: '鉴权检索、引用溯源与多轮对话',
    icon: 'chat',
    fallbackCodes: [PERMISSIONS.AI_CHAT],
  },
  {
    code: PERMISSIONS.MENU_KNOWLEDGE,
    label: '知识维护与导入',
    href: '/knowledge',
    description: '知识台账、批量导入与四维授权',
    icon: 'knowledge',
    fallbackCodes: [
      PERMISSIONS.KNOWLEDGE_VIEW,
      PERMISSIONS.KNOWLEDGE_UPLOAD,
      PERMISSIONS.KNOWLEDGE_MANAGE,
      PERMISSIONS.KNOWLEDGE_GRANT,
    ],
  },
  {
    code: PERMISSIONS.MENU_SEDIMENTATION,
    label: '知识沉淀与运营',
    href: '/sedimentation',
    description: 'FAQ 挖掘审核与知识缺口清单',
    icon: 'sedimentation',
    fallbackCodes: [PERMISSIONS.FAQ_MANAGE, PERMISSIONS.GAP_MANAGE],
  },
  {
    code: PERMISSIONS.MENU_SYSTEM,
    label: '组织与系统配置',
    href: '/system',
    description: '部门树、账号、角色与模型参数',
    icon: 'system',
    fallbackCodes: [PERMISSIONS.SYSTEM_MANAGE],
  },
] as const;

/** 该用户是否可见某个菜单（菜单级鉴权）。 */
export function canAccessMenu(
  user: UserProfile | null | undefined,
  item: MenuItem,
): boolean {
  if (!user) return false;
  if (user.is_superuser) return true;
  if (hasPermission(user, item.code)) return true;
  const fallbacks = item.fallbackCodes ?? [];
  return fallbacks.length > 0 && hasAnyPermission(user, fallbacks);
}

/** 按权限过滤菜单列表，无权限的菜单不渲染。 */
export function visibleMenus(user: UserProfile | null | undefined): MenuItem[] {
  return MENU_ITEMS.filter((item) => canAccessMenu(user, item));
}
