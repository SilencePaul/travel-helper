type TimelineProps = {
  itemIds: string[];
};

export function Timeline({ itemIds }: TimelineProps) {
  if (itemIds.length === 0) {
    return <p className="empty-state">当天地点待安排</p>;
  }

  return (
    <ol className="timeline">
      {itemIds.map((itemId) => <li key={itemId}>{itemId}</li>)}
    </ol>
  );
}
