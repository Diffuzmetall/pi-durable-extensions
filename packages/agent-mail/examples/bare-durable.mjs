import createAgentMailMcp, { AGENT_MAIL_TOOL_NAMES } from "../src/index.ts";

const extension = createAgentMailMcp({
  agentDir: "/path/to/isolated-agent-config",
});

console.log(JSON.stringify({
  extension: extension.name,
  toolCount: extension.tools.length,
  firstTool: extension.tools[0]?.name,
  lastTool: extension.tools.at(-1)?.name,
  catalogCount: AGENT_MAIL_TOOL_NAMES.length,
}, null, 2));
