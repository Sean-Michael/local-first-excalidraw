/**
 * How the editor's chrome adapts to the width it has: the sidebar, the canvas and the assistant
 * panel share one window. Pure functions, so the page and the tests share them.
 */

/** Width of the assistant panel beside the canvas (`.lfx-chat` in styles.css). */
export const CHAT_WIDTH = 380;

/** The narrowest canvas that is still comfortable to draw on with the assistant open. */
export const MIN_CANVAS_WITH_CHAT = 560;

/**
 * Excalidraw's top bar holds its menu button, the toolbar (550 px) and the controls this app
 * adds at the top right. Below these widths the full-size controls no longer fit beside the
 * toolbar and would be pushed off the right edge.
 */
const FULL_TOP_BAR = 1000;
/** The stale-code-links badge takes about this much more. */
const LINKS_BADGE = 180;

/** Whether the top-right controls should shrink to icons and wrap under each other. */
export function compactTopBar(canvasWidth: number, linksBadge = false): boolean {
  return canvasWidth > 0 && canvasWidth < FULL_TOP_BAR + (linksBadge ? LINKS_BADGE : 0);
}

/**
 * Whether the drawings sidebar should close when the assistant opens: with both open the
 * canvas would be too narrow to see what the assistant draws.
 */
export function sidebarShouldYield(canvasWidth: number, sidebarOpen: boolean): boolean {
  return sidebarOpen && canvasWidth > 0 && canvasWidth - CHAT_WIDTH < MIN_CANVAS_WITH_CHAT;
}
