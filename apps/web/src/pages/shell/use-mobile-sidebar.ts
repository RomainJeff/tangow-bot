import { useMediaQuery } from "../../lib/use-media-query";
import { PHONE_MEDIA } from "./layout";

/**
 * At phone width the bot list is a page of its own, as in the iPhone app: the shell's bare
 * route (`/app`) shows it full screen, unless a side panel opened from it covers the column.
 * Opening a chat is a navigation, so the browser's back gesture returns to the list.
 */
export function useMobileSidebar({
  listRoute,
  panelOpen,
}: {
  listRoute: boolean;
  panelOpen: boolean;
}) {
  const phone = useMediaQuery(PHONE_MEDIA);
  return phone && listRoute && !panelOpen;
}
