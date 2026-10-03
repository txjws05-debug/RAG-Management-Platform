'use client';

import { useSyncExternalStore } from 'react';

/** 没有需要订阅的外部源：这个值只会在 React 首次于浏览器运行时翻转一次。 */
const subscribeToNothing = () => () => {};

/**
 * 仅在浏览器中运行时为 true；服务端渲染与客户端首帧渲染时为 false。
 *
 * 任何读取 `localStorage`（登录态、用户信息、主题偏好、折叠状态）的组件都必须用它兜住：
 * 这些值在服务端不存在，直接读进渲染输出会让服务端 HTML 与客户端首帧不一致，
 * React 会判定为水合不匹配（hydration mismatch）并丢弃整棵树重建。
 *
 * 用 `useSyncExternalStore` 表达这一区分，而不是在 effect 里 setState —— 后者会为了
 * 说明「现在在浏览器里了」而额外多触发一轮渲染。
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
}
