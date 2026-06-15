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
  permission: {
    bash?: Record<string, "deny" | "allow" | "ask">;
  };
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
    const key = line
      .slice(0, sep)
      .trim()
      .replace(/^['"]|['"]$/g, "");
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

    // Parse permission rules
    const permission: AgentDefinition["permission"] = {};
    const permRaw = fm.permission;
    if (permRaw && typeof permRaw === "object") {
      const bashRaw = (permRaw as Record<string, unknown>).bash;
      if (bashRaw && typeof bashRaw === "object") {
        const bashRules: Record<string, "deny" | "allow" | "ask"> = {};
        for (const [pattern, action] of Object.entries(
          bashRaw as Record<string, string>,
        )) {
          if (action === "deny" || action === "allow" || action === "ask") {
            bashRules[pattern] = action;
          }
        }
        permission.bash = bashRules;
      }
    }

    if (!name) return null;
    return { name, label, tools, prompt, permission };
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
    name: "fallback",
    label: "fallback",
    tools: ["read", "grep", "find", "ls"],
    prompt: "[fallback]\nYou can only read",
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

  // Helper: simple glob match ( * matches any chars)
  function globMatch(pattern: string, text: string): boolean {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp("^" + escaped.replace(/\*/g, ".*") + "$");
    return regex.test(text);
  }

  // Block tools not in the agent's tool list, with informative reason.
  // Also checks bash commands against agent permission deny patterns.
  pi.on("tool_call", async (event) => {
    const agent = getAgent(currentAgent);

    // Check bash command patterns when bash is allowed
    if (event.toolName === "bash" && agent.permission.bash) {
      const command = event.input.command as string;
      const bashRules = agent.permission.bash;
      for (const [pattern, action] of Object.entries(bashRules)) {
        if (action !== "deny") continue;
        if (globMatch(pattern, command)) {
          return {
            block: true,
            reason: [
              `${agent.label}: bash command denied by rule \`${pattern}\`.`,
              `Command: ${command}`,
            ].join("\n\n"),
          };
        }
      }
    }

    // Block tools not in agent.tools
    if (agent.tools.includes(event.toolName)) return;

    const toolsList = agent.tools.join(", ");
    const deniedTools = ["edit", "write", "bash"].filter(
      (t) => !agent.tools.includes(t),
    );
    const deniedInfo =
      deniedTools.length > 0 ? `\nDenied: ${deniedTools.join(", ")}` : "";

    // First 4 non-empty lines of the agent prompt as mode summary
    const modeSummary = agent.prompt
      .split("\n")
      .filter((l) => l.trim())
      .slice(0, 4)
      .join("\n");

    return {
      block: true,
      reason: [
        `You Are ${agent.name} Agent: \`${event.toolName}\` not allowed. IF you Are Plan, Dont Try to Edit File By Any Way`,
        `Available tools: ${toolsList}${deniedInfo}`,
        modeSummary,
      ].join("\n\n"),
    };
  });

  // Restore state on session start
  pi.on("session_start", async (_event, ctx) => {
    const agent = getAgent(currentAgent);
    pi.setActiveTools(agent.tools);
    ctx.ui.setStatus("agent", agent.label);
  });
}
