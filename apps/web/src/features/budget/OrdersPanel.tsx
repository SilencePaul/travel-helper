import type { BudgetItem, OrderStatus } from "@travel/contracts";

const labels: Record<OrderStatus, string> = { unpaid: "未支付", partial: "部分支付", paid: "已支付" };
function amount(value: number, currency: string) { return `${currency} ${(value / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

export function OrdersPanel({ orders, onStatusChange, onPaidChange, disabled = false }: {
  orders: BudgetItem[];
  onStatusChange: (orderId: string, status: OrderStatus) => void | Promise<unknown>;
  onPaidChange?: (orderId: string, paid: number) => void | Promise<unknown>;
  disabled?: boolean;
}) {
  return (
    <section className="orders-panel" aria-labelledby="orders-heading">
      <div><p className="eyebrow">预订</p><h2 id="orders-heading">订单与付款</h2></div>
      {orders.length === 0 ? <p className="empty-state">尚未录入订单；酒店候选价格仅作比较，不会被当作已预订或已付款。</p> : <ul className="order-list">
        {orders.map((order) => <li key={order.id}>
          <div><strong>{order.name}</strong><span>{amount(order.estimated, order.currency)} · 已付 {amount(order.paid, order.currency)}</span></div>
          <label>{order.name}已付金额<input aria-label={`${order.name}已付金额`} type="number" min="0" step="0.01" disabled={disabled || !onPaidChange} value={(order.paid / 100).toFixed(2)} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 0) void onPaidChange?.(order.id, Math.round(value * 100)); }} /></label>
          <label>{order.name}状态<select aria-label={`${order.name}状态`} aria-describedby={order.status !== "partial" ? `${order.id}-partial-help` : undefined} value={order.status} disabled={disabled} onChange={(event) => void onStatusChange(order.id, event.target.value as OrderStatus)}>
            {(Object.keys(labels) as OrderStatus[]).map((status) => <option key={status} value={status} disabled={status === "partial" && order.status !== "partial"}>{labels[status]}</option>)}
          </select></label>
          {order.status !== "partial" ? <span id={`${order.id}-partial-help`} className="order-status-help">请先录入介于 0 与预计金额之间的已付金额，才能标记为部分支付。</span> : null}
        </li>)}
      </ul>}
    </section>
  );
}
