// Entry of mcp.mjs: the MCP server over stdio. stdout carries the protocol, so nothing else may write to it.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './mcp.ts';

const server = createServer();
await server.connect(new StdioServerTransport());
