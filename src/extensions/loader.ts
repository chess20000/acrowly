import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionExecutionContext, ExtensionToolDefinition } from "../types.js";

export interface LoadedExtensionInfo {
  file: string;
  tools: string[];
  error?: string;
}

export class ExtensionLoader {
  private tools = new Map<string, ExtensionToolDefinition>();
  private loadReport: LoadedExtensionInfo[] = [];
  private reloadCounter = 0;

  constructor(private readonly extensionsDir: string) {}

  async reload(): Promise<{
    loadedTools: string[];
    report: LoadedExtensionInfo[];
  }> {
    await fs.mkdir(this.extensionsDir, { recursive: true });
    const entries = await fs.readdir(this.extensionsDir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && (e.name.endsWith(".mjs") || e.name.endsWith(".js")))
      .map((e) => e.name)
      .sort();

    const nextTools = new Map<string, ExtensionToolDefinition>();
    const report: LoadedExtensionInfo[] = [];
    this.reloadCounter += 1;

    for (const file of files) {
      const fullPath = path.join(this.extensionsDir, file);
      try {
        const stat = await fs.stat(fullPath);
        const url = `${pathToFileURL(fullPath).href}?v=${stat.mtimeMs}_${this.reloadCounter}`;
        const mod = (await import(url)) as Record<string, unknown>;
        const candidates = this.extractToolDefinitions(mod);
        const names: string[] = [];

        for (const def of candidates) {
          if (
            typeof def.name === "string" &&
            def.name.trim().length > 0 &&
            typeof def.execute === "function"
          ) {
            const toolName = `ext_${def.name.replace(/^ext_/, "")}`;
            nextTools.set(toolName, {
              ...def,
              name: toolName,
              description: def.description || `Extension tool from ${file}`,
              parameters: def.parameters || { type: "object", properties: {} },
            });
            names.push(toolName);
          }
        }

        report.push({ file, tools: names });
      } catch (err) {
        report.push({
          file,
          tools: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.tools = nextTools;
    this.loadReport = report;
    return {
      loadedTools: Array.from(this.tools.keys()),
      report,
    };
  }

  getTools(): ExtensionToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getTool(name: string): ExtensionToolDefinition | undefined {
    return this.tools.get(name);
  }

  getReport(): LoadedExtensionInfo[] {
    return this.loadReport;
  }

  async executeTool(
    name: string,
    args: Record<string, unknown>,
    ctx: ExtensionExecutionContext
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Extension tool "${name}" is not loaded.`);
    }
    const result = await tool.execute(args, ctx);
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  }

  private extractToolDefinitions(mod: Record<string, unknown>): ExtensionToolDefinition[] {
    const collected: ExtensionToolDefinition[] = [];
    const defExport = mod.default;

    if (Array.isArray(mod.tools)) {
      collected.push(...(mod.tools as ExtensionToolDefinition[]));
    } else if (Array.isArray(defExport)) {
      collected.push(...(defExport as ExtensionToolDefinition[]));
    } else if (
      defExport &&
      typeof defExport === "object" &&
      "tools" in defExport &&
      Array.isArray((defExport as { tools?: unknown }).tools)
    ) {
      collected.push(...((defExport as { tools: ExtensionToolDefinition[] }).tools));
    } else if (defExport && typeof defExport === "object" && "execute" in defExport) {
      collected.push(defExport as ExtensionToolDefinition);
    } else if (typeof mod.execute === "function" && typeof mod.name === "string") {
      collected.push(mod as unknown as ExtensionToolDefinition);
    }

    return collected;
  }
}
