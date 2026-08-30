import type { BudgetItem, OrderStatus } from "@travel/contracts";
import { useEffect, useId, useRef, useState } from "react";

const labels: Record<OrderStatus, string> = { unpaid: "未支付", partial: "部分支付", paid: "已支付" };
function amount(value: number, currency: string) { return `${currency} ${(value / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function draftCents(draft: string): { cents?: number; error?: string } {
  if (!/^\d+(?:\.\d{1,2})?$/.test(draft)) return { error: "请输入最多两位小数的非负已付金额" };
  const [whole, fraction = ""] = draft.split(".");
  const cents = Number(`${whole}${fraction.padEnd(2, "0")}`);
  return Number.isSafeInteger(cents) ? { cents } : { error: "金额过大，无法安全保存到分" };
}

function statusDescription(order: BudgetItem, dirty: boolean, pending: boolean, disabled: boolean) {
  const lockReason = disabled
    ? "行程正在保存；完成后才能更改支付状态。"
    : pending
      ? "正在保存付款金额；保存完成后才能更改支付状态。"
      : dirty
        ? "金额尚未保存；请先保存金额，再更改支付状态。"
        : undefined;
  const amountRule = order.paid === 0
    ? "实际已付金额为 0 时，只能选择未支付。"
    : "已有已付金额时，不能选择未支付；请先将已付金额保存为 0。";
  return [lockReason, amountRule].filter(Boolean).join(" ");
}

export function OrdersPanel({ orders, onStatusChange, onPaidChange, disabled = false }: {
  orders: BudgetItem[];
  onStatusChange: (orderId: string, status: OrderStatus) => void | Promise<unknown>;
  onPaidChange?: (orderId: string, paid: number) => void | Promise<unknown>;
  disabled?: boolean;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [rowStates, setRowStates] = useState<Record<string, "dirty" | "saving" | "success" | "error">>({});
  const [errors, setErrors] = useState<Record<string, { message: string; invalid: boolean }>>({});
  const amountInputRefs = useRef(new Map<string, HTMLInputElement>());
  const orderIdsPrefix = useId();
  useEffect(() => {
    /* oxlint-disable react/set-state-in-effect -- persisted order updates resync untouched local drafts. */
    setDrafts((current) => Object.fromEntries(orders.map((order) => [order.id, dirtyIds.has(order.id) ? current[order.id] ?? (order.paid / 100).toFixed(2) : (order.paid / 100).toFixed(2)])));
    /* oxlint-enable react/set-state-in-effect */
  }, [orders, dirtyIds]);
  async function savePaid(order: BudgetItem) {
    const draft = drafts[order.id] ?? (order.paid / 100).toFixed(2);
    const parsed = draftCents(draft);
    if (parsed.cents === undefined) {
      setErrors((current) => ({ ...current, [order.id]: { message: parsed.error!, invalid: true } }));
      setRowStates((current) => ({ ...current, [order.id]: "error" }));
      return;
    }
    if (!onPaidChange || parsed.cents === order.paid) {
      setDirtyIds((current) => { const next = new Set(current); next.delete(order.id); return next; });
      setErrors((current) => { const next = { ...current }; delete next[order.id]; return next; });
      setRowStates((current) => { const next = { ...current }; delete next[order.id]; return next; });
      return;
    }
    setPendingIds((current) => new Set(current).add(order.id));
    setErrors((current) => { const next = { ...current }; delete next[order.id]; return next; });
    setRowStates((current) => ({ ...current, [order.id]: "saving" }));
    try {
      await onPaidChange(order.id, parsed.cents);
      setDirtyIds((current) => { const next = new Set(current); next.delete(order.id); return next; });
      setRowStates((current) => ({ ...current, [order.id]: "success" }));
    } catch {
      setErrors((current) => ({ ...current, [order.id]: { message: "保存付款金额失败，请重试", invalid: false } }));
      setRowStates((current) => ({ ...current, [order.id]: "error" }));
      requestAnimationFrame(() => amountInputRefs.current.get(order.id)?.focus());
    } finally {
      setPendingIds((current) => { const next = new Set(current); next.delete(order.id); return next; });
    }
  }
  return (
    <section className="orders-panel" aria-labelledby="orders-heading">
      <div><p className="eyebrow">预订</p><h2 id="orders-heading">订单与付款</h2></div>
      {orders.length === 0 ? <p className="empty-state">尚未录入订单；酒店候选价格仅作比较，不会被当作已预订或已付款。</p> : <ul className="order-list">
        {orders.map((order) => {
          const error = errors[order.id];
          const rowState = rowStates[order.id] ?? (dirtyIds.has(order.id) ? "dirty" : "idle");
          const dirty = dirtyIds.has(order.id);
          const pending = pendingIds.has(order.id);
          const safeOrderId = encodeURIComponent(order.id);
          const errorId = `${orderIdsPrefix}-${safeOrderId}-amount-error`;
          const statusHelpId = `${orderIdsPrefix}-${safeOrderId}-status-help`;
          const statusHelp = statusDescription(order, dirty, pending, disabled);
          return <li key={order.id} data-order-state={rowState}>
          <div><strong>{order.name}</strong><span>{amount(order.estimated, order.currency)} · 已付 {amount(order.paid, order.currency)}</span></div>
          <label>{order.name}已付金额<input ref={(element) => { if (element) amountInputRefs.current.set(order.id, element); else amountInputRefs.current.delete(order.id); }} className="control-field" aria-label={`${order.name}已付金额`} aria-invalid={error?.invalid || undefined} aria-describedby={error ? errorId : undefined} type="number" min="0" step="0.01" disabled={disabled || !onPaidChange || pending} value={drafts[order.id] ?? (order.paid / 100).toFixed(2)} onChange={(event) => { const draft = event.target.value; setDrafts((current) => ({ ...current, [order.id]: draft })); const isClean = draftCents(draft).cents === order.paid; setDirtyIds((current) => { if (isClean && !current.has(order.id)) return current; if (!isClean && current.has(order.id)) return current; const next = new Set(current); if (isClean) next.delete(order.id); else next.add(order.id); return next; }); setErrors((current) => { const next = { ...current }; delete next[order.id]; return next; }); setRowStates((current) => { const next = { ...current }; if (isClean) delete next[order.id]; else next[order.id] = "dirty"; return next; }); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void savePaid(order); } }} /></label>
          <button className="control-button control-button--primary" aria-label={`保存 ${order.name} 金额`} aria-busy={pending} type="button" disabled={disabled || !onPaidChange || pending} onClick={() => void savePaid(order)}>{pending ? "正在保存" : "保存金额"}</button>
          <label>{order.name}状态<select className="control-field" aria-label={`${order.name}状态`} aria-describedby={statusHelpId} value={order.status} disabled={disabled || dirty || pending} onChange={(event) => void onStatusChange(order.id, event.target.value as OrderStatus)}>
            {(Object.keys(labels) as OrderStatus[]).map((status) => <option key={status} value={status} disabled={order.paid === 0 ? status !== "unpaid" : status === "unpaid"}>{labels[status]}</option>)}
          </select></label>
          <span id={statusHelpId} className="order-status-help">{statusHelp}</span>
          {rowState === "dirty" ? <p className="order-row-status" role="status">金额尚未保存</p> : null}
          {rowState === "saving" ? <p className="order-row-status" role="status">正在保存付款金额</p> : null}
          {rowState === "success" ? <p className="order-row-status order-row-status--success" role="status">付款金额已保存</p> : null}
          {error ? <p id={errorId} className="order-row-status order-row-status--error" role="alert">{error.message}</p> : null}
        </li>;
        })}
      </ul>}
    </section>
  );
}
