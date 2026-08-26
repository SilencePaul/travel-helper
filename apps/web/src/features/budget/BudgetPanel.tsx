import { budgetTotals, type BudgetCategory, type Trip } from "@travel/contracts";

const categoryLabel: Record<BudgetCategory, string> = {
  flight: "机票", hotel: "酒店", transport: "交通", ticket: "门票", food: "餐饮",
};

function amount(value: number) {
  return (value / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function Totals({ totals, compact = false }: { totals: Record<string, { estimated: number; paid: number }>; compact?: boolean }) {
  const entries = Object.entries(totals);
  if (entries.length === 0) return <span>暂无</span>;
  return <>{entries.map(([currency, total]) => <span key={currency}>{compact ? `${currency} ${amount(total.estimated)} / 已付 ${amount(total.paid)}` : `${currency} ${amount(total.estimated)} · 已付 ${amount(total.paid)}`}</span>)}</>;
}

export function BudgetPanel({ trip }: { trip: Trip }) {
  const totals = budgetTotals(trip);
  return (
    <section className="budget-panel" aria-labelledby="budget-heading">
      <div>
        <p className="eyebrow">预算</p>
        <h2 id="budget-heading">总预算</h2>
        <div className="budget-total"><Totals totals={totals.trip} /></div>
      </div>
      <div className="budget-breakdown">
        <div><h3>类别</h3><ul>{(Object.keys(categoryLabel) as BudgetCategory[]).map((category) => <li key={category}>{categoryLabel[category]} · <Totals totals={totals.byCategory[category]} compact /></li>)}</ul></div>
        <div><h3>每日</h3><ul>{trip.days.map((day, index) => <li key={day.id}>D{index + 1} · <Totals totals={totals.byDay[day.id]!} compact /></li>)}</ul></div>
      </div>
    </section>
  );
}
