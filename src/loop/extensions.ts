import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import type { OllamaTool, ToolContext } from "./tools";

/**
 * Bring-your-own tools. Alter's built-in tool palette is generic (web search,
 * page fetch, platform skills, notes, voice). Anything specific to one owner's
 * machine (a private workspace, a dashboard, a research pipeline) belongs in
 * an extension module outside the repo, named by ALTER_TOOLS_EXTENSION.
 *
 * The module exports any of:
 *   tools(): OllamaTool[]                     extra tool definitions
 *   execute(name, args, ctx): Promise<string | null>
 *                                             result text, or null if the tool is not its own
 *   capabilities(): string                    prompt text appended to the capabilities block
 *
 * Loading happens once per process. A missing or broken module logs a warning
 * and the persona runs with the built-in tools only; it never breaks a reply.
 */
export interface ToolsExtension {
  tools?: () => OllamaTool[];
  execute?: (name: string, args: Record<string, unknown>, ctx: ToolContext) => Promise<string | null>;
  capabilities?: () => string;
}

let loaded: ToolsExtension | null = null;
let loadedFrom: string | null = null;

export function extensionPath(): string | null {
  const p = process.env.ALTER_TOOLS_EXTENSION?.trim();
  return p ? path.resolve(p) : null;
}

/** Load (or reload, when the path changed) the configured extension. */
export async function loadToolsExtension(): Promise<ToolsExtension | null> {
  const p = extensionPath();
  if (!p) {
    loaded = null;
    loadedFrom = null;
    return null;
  }
  if (loadedFrom === p && loaded) return loaded;
  if (!fs.existsSync(p)) {
    console.warn(`[tools] ALTER_TOOLS_EXTENSION not found: ${p} (running with built-in tools only)`);
    loaded = null;
    loadedFrom = p;
    return null;
  }
  try {
    const mod = (await import(pathToFileURL(p).href)) as ToolsExtension;
    loaded = mod;
    loadedFrom = p;
    return mod;
  } catch (e) {
    console.warn(`[tools] failed to load ALTER_TOOLS_EXTENSION ${p}: ${String(e).slice(0, 200)}`);
    loaded = null;
    loadedFrom = p;
    return null;
  }
}

/** The extension as last loaded (synchronous view for prompt rendering). */
export function currentToolsExtension(): ToolsExtension | null {
  return loaded;
}

/** Test hook: forget the loaded module so the next load re-imports. */
export function resetToolsExtensionForTests(): void {
  loaded = null;
  loadedFrom = null;
}
