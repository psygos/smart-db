import { useMemo, useState } from "react";
import { api, type InventorySummaryRow, type PartTypeItemsResponse } from "../api";
import { formatQuantity } from "../SmartApp.helpers";

interface InventoryTabProps {
  rows: InventorySummaryRow[];
  isLoading: boolean;
  onRefresh: () => void;
}

export function InventoryTab({ rows, isLoading, onRefresh }: InventoryTabProps) {
  const [query, setQuery] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [itemsCache, setItemsCache] = useState<Map<string, PartTypeItemsResponse>>(new Map());
  const [expandLoading, setExpandLoading] = useState(false);

  const expandedItems = expandedId ? itemsCache.get(expandedId) ?? null : null;

  async function toggleExpand(partTypeId: string): Promise<void> {
    if (expandedId === partTypeId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(partTypeId);
    if (itemsCache.has(partTypeId)) return;
    setExpandLoading(true);
    try {
      const items = await api.getPartTypeItems(partTypeId);
      setItemsCache((prev) => new Map(prev).set(partTypeId, items));
    } catch {
      setItemsCache((prev) => new Map(prev).set(partTypeId, { bulkStocks: [], instances: [] }));
    } finally {
      setExpandLoading(false);
    }
  }

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (!showEmpty && row.bins === 0 && row.instanceCount === 0) return false;
      if (!q) return true;
      const blob = [
        row.canonicalName,
        row.categoryPath.join(" / "),
        row.unit.symbol,
      ].join(" ").toLowerCase();
      return blob.includes(q);
    });

    const groups = new Map<string, InventorySummaryRow[]>();
    for (const row of filtered) {
      const top = row.categoryPath[0] ?? "Uncategorized";
      const list = groups.get(top) ?? [];
      list.push(row);
      groups.set(top, list);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows, query, showEmpty]);

  const totals = useMemo(() => {
    let parts = 0;
    let bulks = 0;
    let instances = 0;
    let onHand = 0;
    for (const row of rows) {
      parts += 1;
      bulks += row.bins;
      instances += row.instanceCount;
      onHand += row.onHand;
    }
    return { parts, bulks, instances, onHand };
  }, [rows]);

  return (
    <section
      role="tabpanel"
      id="panel-inventory"
      aria-labelledby="tab-inventory"
      className="panel"
    >
      <div className="stock-controls">
        <input
          type="search"
          aria-label="Filter inventory"
          value={query}
          placeholder="Search..."
          onChange={(event) => setQuery(event.target.value)}
        />
        <label className="inventory-toggle">
          <input
            type="checkbox"
            checked={showEmpty}
            onChange={(event) => setShowEmpty(event.target.checked)}
          />
          Show empty
        </label>
      </div>

      {grouped.length === 0 ? (
        <p className="muted-copy">No inventory entries match your filter.</p>
      ) : (
        grouped.map(([top, items]) => (
          <section key={top} className="inventory-group">
            <h3 className="inventory-group-title">
              <span>{top}</span>
              <span className="inventory-group-count">{items.length}</span>
            </h3>
            <ul className="inventory-list">
              {items.map((row) => {
                const subPath = row.categoryPath.slice(1).join(" / ");
                const isStocked = row.bins > 0 || row.instanceCount > 0;
                const isExpanded = expandedId === row.id;
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      className={`inventory-row ${isStocked ? "stocked" : "empty"} ${isExpanded ? "expanded" : ""}`}
                      onClick={() => void toggleExpand(row.id)}
                      aria-expanded={isExpanded}
                    >
                      <div className="inventory-row-name">
                        <strong>{row.canonicalName}</strong>
                        {subPath ? <span>{subPath}</span> : null}
                      </div>
                      <div className="inventory-row-quantity">
                        {row.countable ? (
                          <>
                            <span className="qty-value">{row.instanceCount}</span>
                            <span className="qty-unit">items</span>
                          </>
                        ) : (
                          <>
                            <span className="qty-value">
                              {formatQuantity(row.onHand)}
                            </span>
                            <span className="qty-unit">{row.unit.symbol}</span>
                          </>
                        )}
                      </div>
                    </button>
                    {isExpanded ? (
                      <div className="inventory-row-detail">
                        {expandLoading && !expandedItems ? (
                          <p className="muted-copy">Loading...</p>
                        ) : expandedItems && (expandedItems.bulkStocks.length > 0 || expandedItems.instances.length > 0) ? (
                          <ul className="inventory-detail-list">
                            {expandedItems.bulkStocks.map((bs) => (
                              <li key={bs.id} className="inventory-detail-item">
                                <code>{bs.qrCode}</code>
                                <span>{bs.location}</span>
                                <strong>{formatQuantity(bs.quantity)} {row.unit.symbol}</strong>
                              </li>
                            ))}
                            {expandedItems.instances.map((inst) => (
                              <li key={inst.id} className="inventory-detail-item">
                                <code>{inst.qrCode}</code>
                                <span>{inst.location}</span>
                                <strong>{inst.status}</strong>
                                {inst.assignee ? <span>{inst.assignee}</span> : null}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="muted-copy">No items assigned to this part type.</p>
                        )}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </section>
  );
}
