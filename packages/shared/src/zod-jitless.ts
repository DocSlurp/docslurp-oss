/**
 * Side-effect module: turns off zod's eval-compiled parsers (built with the Function constructor) for this process.
 * zod reads the setting when each schema is constructed, so it only works when this module is evaluated before any
 * module that builds a schema: the parser-VM chart guest imports it first (`guest-entry.ts`). The guest also runs with
 * V8's code generation from strings disabled, so a late import would fail loudly rather than silently compile.
 * Process-wide, so only for single-purpose processes; never re-exported from the package index.
 */
import { z } from "zod";

z.config({ jitless: true });
