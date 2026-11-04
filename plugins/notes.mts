/**
 * Minimal note-keeping plugin (example).
 *
 * Registers one junior-role tool, `write_note`, whose write goes through
 * the run workspace — confined and approval-gated like a built-in tool.
 * A minimal example of the legacy v1 call shape (positional description and
 * params_schema; see docs/plugins.md). The `.mts` extension
 * keeps the module kind unambiguous ESM without a package.json `type`.
 */

import type { PluginContext } from "@two-brothers/harness";

export function register(ctx: PluginContext): void {
  ctx.set_description("Keep short notes inside the workspace");

  async function write_note(args: { text: string; filename?: string }): Promise<unknown> {
    const filename = args.filename ?? "notes.txt";
    const result = await ctx.workspace_write(filename, args.text);
    if (result.status !== "ok") {
      return result; // structured result: the graph surfaces "denied"
    }
    return `note saved to ${filename}`;
  }

  ctx.add_tool(
    "write_note",
    write_note,
    "Write (overwrite) a short note file inside the workspace",
    { text: "string", filename: "string" },
    "junior",
  );
}
