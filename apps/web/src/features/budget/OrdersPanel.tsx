import type { BudgetItem, OrderStatus } from "@travel/contracts";
import { useEffect, useState } from "react";

const labels: Record<OrderStatus, string> = { unpaid: "未支付", partial: "部分支付", paid: "已支付" };
function amount(value: number, currency: string) { return `${currency} ${(value / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

export function OrdersPanel({ orders, onStatusChange, onPaidChange, disabled = false }: {
  orders: BudgetItem[];
  onStatusChange: (orderId: string, status: OrderStatus) => void | Promise<unknown>;
  onPaidChange?: (orderId: string, paid: number) => void | Promise<unknown>;
  disabled?: boolean;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
  const [savingId, setSavingId] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    /* oxlint-disable react/set-state-in-effect -- persisted order updates resync untouched local drafts. */
    setDrafts((current) => Object.fromEntries(orders.map((order) => [order.id, dirtyIds.has(order.id) ? current[order.id] ?? (order.paid / 100).toFixed(2) : (order.paid / 100).toFixed(2)])));
    /* oxlint-enable react/set-state-in-effect */
  }, [orders, dirtyIds]);
  async function savePaid(order: BudgetItem) {
    const draft = drafts[order.id] ?? (order.paid / 100).toFixed(2);
    if (!/^\d+(?:\.\d{1,2})?$/.test(draft)) { setError("请输入最多两位小数的非负已付金额"); return; }
    const value = Number(draft);
    if (!onPaidChange || value === order.paid / 100) return;
    setSavingId(order.id); setError(undefined);
    try { await onPaidChange(order.id, Math.round(value * 100)); setDirtyIds((current) => { const next = new Set(current); next.delete(order.id); return next; }); } catch { setError("保存付款金额失败，请重试"); } finally { setSavingId(undefined); }
  }
  return (
    <section className="orders-panel" aria-labelledby="orders-heading">
      <div><p className="eyebrow">预订</p><h2 id="orders-heading">订单与付款</h2></div>
      {orders.length === 0 ? <p className="empty-state">尚未录入订单；酒店候选价格仅作比较，不会被当作已预订或已付款。</p> : <ul className="order-list">
        {orders.map((order) => <li key={order.id}>
          <div><strong>{order.name}</strong><span>{amount(order.estimated, order.currency)} · 已付 {amount(order.paid, order.currency)}</span></div>
          <label>{order.name}已付金额<input aria-label={`${order.name}已付金额`} type="number" min="0" step="0.01" disabled={disabled || !onPaidChange || savingId === order.id} value={drafts[order.id] ?? (order.paid / 100).toFixed(2)} onChange={(event) => { setDrafts((current) => ({ ...current, [order.id]: event.target.value })); setDirtyIds((current) => new Set(current).add(order.id)); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void savePaid(order); } }} /></label>
          <button type="button" disabled={disabled || !onPaidChange || savingId === order.id} onClick={() => void savePaid(order)}>{savingId === order.id ? "正在保存" : "保存金额"}</button>
          <label>{order.name}状态<select aria-label={`${order.name}状态`} aria-describedby={order.status !== "partial" ? `${order.id}-partial-help` : undefined} value={order.status} disabled={disabled || dirtyIds.has(order.id) || savingId === order.id} onChange={(event) => void onStatusChange(order.id, event.target.value as OrderStatus)}>
            {(Object.keys(labels) as OrderStatus[]).map((status) => <option key={status} value={status} disabled={status === "partial" && order.status !== "partial"}>{labels[status]}</option>)}
          </select></label>
          {order.status !== "partial" ? <span id={`${order.id}-partial-help`} className="order-status-help">请先录入实际已付金额，才能标记为部分支付。</span> : null}
        </li>)}
      </ul>}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
