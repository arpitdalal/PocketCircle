import { MarketingHome } from "~/components/marketing-home.js";

/** Public `/home`: same marketing page as signed-out `/`, without an auth gate. */
export default function MarketingHomeRoute() {
  return <MarketingHome />;
}
