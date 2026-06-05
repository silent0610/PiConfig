/**
 * Agent Mode Switcher for pi
 *
 * Agent definitions are loaded from ~/.pi/agent/agents/*.md files.
 * Each file uses YAML frontmatter for config + Markdown body for prompt:
 *
 *   ---
 *   name: build
 *   label: "🔧 Build"
 *   tools: "read,bash,edit,write,grep,find,ls"
 *   permission:
 *     read: allow
 *     bash:
 *       "rm *": deny
 *   ---
 *
 *   [BUILD MODE] You are a builder...
 *
 * - name/label/tools → used by this extension
 * - permission       → used by pi-permission-system (per-agent rules)
 * - Markdown body    → injected into system prompt as agent instructions
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ── Parse frontmatter + body from .md ──────────────────────────────────────

interface AgentDefinition {
  name: string;
  label: string;
  tools: string[];
  prompt: string;
}

const AGENTS_DIR = join(getAgentDir(), "agents");

function parseFrontmatter(raw: string): Record<string, unknown> {
  // Minimal YAML parser: key: value, key: (nested), handles quotes
  const root: Record<string, unknown> = {};
  const stack: { indent: number; target: Record<string, unknown> }[] = [
    { indent: -1, target: root },
  ];
  for (const rawLine of raw.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    const sep = line.indexOf(":");
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim().replace(/^['"]|['"]$/g, "");
    const rawValue = line.slice(sep + 1).trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const current = stack[stack.length - 1].target;
    if (!rawValue) {
      const child: Record<string, unknown> = {};
      current[key] = child;
      stack.push({ indent, target: child });
    } else {
      let scalar = rawValue;
      if (
        (scalar.startsWith('"') && scalar.endsWith('"')) ||
        (scalar.startsWith("'") && scalar.endsWith("'"))
      ) {
        scalar = scalar.slice(1, -1);
      }
      current[key] = scalar;
    }
  }
  return root;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

export function extractFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return "";
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return "";
  return normalized.slice(4, end);
}

function loadAgentFile(filePath: string): AgentDefinition | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const fmRaw = extractFrontmatter(content);
    if (!fmRaw) return null;
    const fm = parseFrontmatter(fmRaw);
    const name = typeof fm.name === "string" ? fm.name : "";
    const label = typeof fm.label === "string" ? fm.label : name;
    const toolsRaw = typeof fm.tools === "string" ? fm.tools : "";
    const tools = toolsRaw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const prompt = stripFrontmatter(content);
    if (!name) return null;
    return { name, label, tools, prompt };
  } catch {
    return null;
  }
}

function loadAllAgents(): Map<string, AgentDefinition> {
  const map = new Map<string, AgentDefinition>();
  if (!existsSync(AGENTS_DIR)) return map;
  for (const entry of readdirSync(AGENTS_DIR)) {
    if (!entry.endsWith(".md")) continue;
    const agent = loadAgentFile(join(AGENTS_DIR, entry));
    if (agent) map.set(agent.name, agent);
  }
  return map;
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const agents = loadAllAgents();
  let currentAgent = agents.keys().next().value ?? "build";
  const fallbackAgent: AgentDefinition = {
    name: "build",
    label: "🔧 Build",
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    prompt: "[BUILD MODE]\nYou are a builder/implementor.",
  };

  function getAgent(name: string): AgentDefinition {
    return agents.get(name) ?? fallbackAgent;
  }

  function switchAgent(name: string, ctx: ExtensionContext) {
    currentAgent = name;
    const agent = getAgent(name);
    pi.setActiveTools(agent.tools);
    ctx.ui.setStatus("agent", agent.label);
    ctx.ui.notify(`Switched to ${agent.label}`, "info");
  }

  // /agent command
  pi.registerCommand("agent", {
    description: "Switch agent mode",
    async handler(args, ctx) {
      const trimmed = args?.trim().toLowerCase();
      if (trimmed && agents.has(trimmed)) {
        switchAgent(trimmed, ctx);
        return;
      }
      const choices = [...agents.values()].map((a) => a.label);
      const choice = await ctx.ui.select("Select agent:", choices);
      if (!choice) return;
      const matched = [...agents.values()].find((a) => a.label === choice);
      if (matched) switchAgent(matched.name, ctx);
    },
  });

  // Inject agent prompt + <active_agent> tag before each turn
  pi.on("before_agent_start", async (event) => {
    const agent = getAgent(currentAgent);
    return {
      systemPrompt:
        event.systemPrompt +
        `\n<active_agent name="${currentAgent}">` +
        "\n\n" +
        agent.prompt,
    };
  });

  // Ctrl+Alt+P — cycle through agents
  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "Cycle to next agent",
    async handler(ctx) {
      const names = [...agents.keys()];
      const idx = names.indexOf(currentAgent);
      const next = names[(idx + 1) % names.length];
      switchAgent(next, ctx);
    },
  });

  // Block write tools for agents that don't have them
  pi.on("tool_call", async (event) => {
    const agent = getAgent(currentAgent);
    if (agent.tools.includes(event.toolName)) return;
    return {
      block: true,
      reason: `${agent.label}: ${event.toolName} not allowed`,
    };
  });

  // Restore state on session start
  pi.on("session_start", async (_event, ctx) => {
    const agent = getAgent(currentAgent);
    pi.setActiveTools(agent.tools);
    ctx.ui.setStatus("agent", agent.label);
  });
}
