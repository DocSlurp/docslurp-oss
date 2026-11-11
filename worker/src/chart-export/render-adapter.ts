/**
 * Spec -> format renderers. The single implementation lives in `@docslurp/shared` (`chart-export-render.ts`) so the
 * worker, server and clients render identical output; this module only re-exports the two entry points the generator
 * stage uses.
 */
export { renderFencedBlock, renderVisual } from "@docslurp/shared";
