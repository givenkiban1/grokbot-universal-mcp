// Local entry point: Claude Code / Claude Desktop launch this process and talk over stdin/stdout.
// Never write to stdout here; it carries the MCP protocol. Log with console.error.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp.ts";

await createServer({ elicit: true, cwd: process.cwd() }).connect(new StdioServerTransport());
console.error("grok-bot-universal: MCP server running on stdio");
