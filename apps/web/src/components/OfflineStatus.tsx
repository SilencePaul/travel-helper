import { useEffect, useState } from "react";

type OfflineStatusProps = {
  pendingCount?: number;
  conflictPaused?: boolean;
};

export function OfflineStatus({ pendingCount = 0, conflictPaused = false }: OfflineStatusProps) {
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const pendingLabel = pendingCount > 0 ? `，${pendingCount} 项修改待同步` : "";
  const conflictLabel = conflictPaused ? "，同步因版本冲突暂停" : "";
  return (
    <div className="offline-status" role="status" aria-live="polite">
      {online ? `在线${pendingLabel}${conflictLabel}` : `离线：显示最近保存的旅行计划${pendingLabel}${conflictLabel}`}
    </div>
  );
}
