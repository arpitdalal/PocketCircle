import { HistoryList } from "~/components/history-list.js";
import { type Category, type Circle, useCategoryHistory } from "~/lib/data.js";

/** The Category History panel (PRD story 78) — paginated audit fed into {@link HistoryList}. */
export function CategoryHistory({
  circleId,
  categoryId,
  name,
}: {
  circleId: Circle["id"];
  categoryId: Category["id"];
  name: string;
}) {
  const { events, status, loadMore } = useCategoryHistory(circleId, categoryId);
  return (
    <HistoryList events={events} status={status} loadMore={loadMore} label={`${name} history`} />
  );
}
