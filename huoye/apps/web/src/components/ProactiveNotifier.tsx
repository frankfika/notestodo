import { useEffect, useRef } from "react";
import { api } from "../lib/api";
import { newestNotification, shouldNotifyWeb } from "../lib/proactive";

/** 轮询间隔：30 秒一次，够安静，也不至于让人等太久。 */
const POLL_MS = 30_000;

/**
 * 网页端的系统通知。
 *
 * 规则：只有页面不在前台（document.hidden）、浏览器支持 Notification、
 * 而且用户之前已经授权过时，才弹一条短通知；没授权就安静跳过。
 * 这里绝不主动索要权限——权限只在设置页用户点按钮时申请。
 */
export function ProactiveNotifier() {
  const notified = useRef<Set<string>>(new Set());
  const lastNotification = useRef<Notification | null>(null);

  useEffect(() => {
    let stopped = false;

    async function tick() {
      if (stopped) return;
      try {
        const { items } = await api.notifications();
        if (stopped) return;
        const fresh = (items ?? []).filter((item) => !notified.current.has(item.id));
        if (fresh.length === 0) return;

        const supported = typeof Notification !== "undefined";
        const permission = supported ? Notification.permission : "denied";
        const hidden = typeof document !== "undefined" && document.hidden;
        if (!shouldNotifyWeb({ hidden, supported, permission, items: fresh })) return;

        const item = newestNotification(fresh);
        if (!item) return;
        try {
          // 正文由服务端截到 60 字以内，详情留在聊天卡片和今天页。
          lastNotification.current = new Notification(item.title, { body: item.body, tag: item.id });
        } catch {
          // 浏览器偶尔会拦下通知，拦下就算了，不打断界面。
        }
        for (const one of fresh) notified.current.add(one.id);
        await api.ackNotifications();
      } catch {
        // 服务端还没接通或网络不通时安静跳过。
      }
    }

    const timer = window.setInterval(() => {
      void tick();
    }, POLL_MS);
    void tick();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  return null;
}
