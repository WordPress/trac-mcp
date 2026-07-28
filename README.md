# WordPress Trac MCP Server

A Model Context Protocol (MCP) server that provides AI assistants with comprehensive access to WordPress.org Trac data. Built with TypeScript and deployed on Cloudflare Workers.

**🆕 Now with ChatGPT Deep Research support!**

## Overview

This MCP server transforms WordPress Trac into an AI-accessible knowledge base, enabling intelligent queries about WordPress development, ticket tracking, and code changes. Features dual architecture supporting both standard MCP clients and ChatGPT's Deep Research requirements.

## Features

- **Dual Architecture**: Standard MCP + ChatGPT Deep Research support
- Search 60,000+ WordPress tickets by keywords, components, or status
- Get detailed ticket information including descriptions, status, and metadata
- Access changeset information with full diff content
- Monitor recent WordPress development activity
- Retrieve project metadata like components, milestones, and priorities
- **Intelligent Query Routing**: Automatically detects ticket numbers, revisions, and keywords
- **Smart Caching**: Optimizes fetch operations for better performance
- WordPress-branded UI with official styling

## Available Tools

The server provides two different tool interfaces depending on your client:

### Standard MCP Tools

For Claude Desktop, MCP Inspector, and other standard MCP clients:

#### searchTickets
Search through WordPress Trac tickets with intelligent filtering.

```json
{
  "tool": "searchTickets",
  "args": {
    "query": "REST API performance",
    "limit": 10,
    "status": "new"
  }
}
```

`status` takes a Trac status: `accepted`, `assigned`, `closed`, `new`,
`reopened`, or `reviewing`. There is no `open` status; passing one returns an
empty result set rather than an error. Omit `status` to search every ticket.

Use `&` to combine filter expressions, or pass `status`, `component`,
`milestone`, and `resolution` as separate arguments. Results include
`totalFound`, `returned`, `page`, `pageSize`, and `hasMore`. A separate
argument overrides the same field in `query`.

```json
{
  "tool": "searchTickets",
  "args": {
    "query": "milestone=6.9&status=closed&resolution=fixed",
    "limit": 50,
    "page": 2
  }
}
```

#### getTicket
Retrieve comprehensive information about specific tickets.

```json
{
  "tool": "getTicket",
  "args": {
    "id": 59166,
    "includeComments": true,
    "commentLimit": 10
  }
}
```

#### getChangeset
Access detailed information about code commits and changes.

```json
{
  "tool": "getChangeset",
  "args": {
    "revision": 55567,
    "includeDiff": true,
    "diffLimit": 2000
  }
}
```

#### getTimeline
Monitor recent WordPress development activity.

```json
{
  "tool": "getTimeline",
  "args": {
    "days": 7,
    "limit": 20
  }
}
```

#### getTracInfo
Get components, milestones, priorities, severities, ticket types, or statuses.

```json
{
  "tool": "getTracInfo",
  "args": {
    "type": "components"
  }
}
```

### ChatGPT Deep Research Tools

For ChatGPT's Deep Research feature (simplified interface):

#### search
Intelligent search that automatically routes to the right data based on your query.

```json
{
  "tool": "search",
  "args": {
    "query": "block editor performance"
  }
}
```

**Supported query types:**
- **Keywords**: `"REST API bugs"`, `"media upload issues"`
- **Ticket numbers**: `"#61234"`, `"61234"`  
- **Changesets**: `"r58504"`, `"58504"`
- **Recent activity**: `"recent"`, `"timeline"`, `"latest"`
- **Components**: `"Block Editor"`, `"REST API"`

#### fetch
Get detailed information about a specific item by ID.

```json
{
  "tool": "fetch",
  "args": {
    "id": "61234"
  }
}
```

**Supported ID formats:**
- Ticket IDs: `"61234"`
- Changeset revisions: `"r58504"`

## Installation

### Deploy to Cloudflare Workers

```bash
# Clone the repository
git clone https://github.com/Jameswlepage/trac-mcp.git
cd trac-mcp

# Install dependencies
npm install

# Login to Cloudflare
wrangler login

# Deploy
npm run deploy
```

### Connect to AI Assistant

#### Standard MCP (Claude Desktop, etc.)

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "wordpress-trac": {
      "command": "npx",
      "args": ["mcp-remote", "https://your-worker-url/mcp"]
    }
  }
}
```

#### ChatGPT Deep Research

ChatGPT uses a different connection method than Claude Desktop. Follow these steps:

1. **Open ChatGPT Settings** → Go to the **Connectors** tab
2. **Add Server** → Import your remote MCP server directly:
   ```
   https://your-worker-url/mcp/chatgpt
   ```
3. **Enable in Composer** → The server will appear in **Composer** > **Deep Research** tool
4. **Add as Source** → You may need to manually add the server as a research source

For detailed setup instructions, see: [ChatGPT MCP Documentation](https://platform.openai.com/docs/mcp#connect-in-chatgpt)

> **Note**: ChatGPT requires exactly 2 tools (`search` and `fetch`) with simplified schemas. The `/mcp/chatgpt` endpoint is specifically optimized for this requirement.

## Development

### Local Development

```bash
# Start development server
npm run dev

# Test with MCP Inspector
npx @modelcontextprotocol/inspector http://localhost:8787/mcp
```

### Testing

```bash
# Run type checking
npm run type-check

# Run linting
npm run lint

# Test deployment
curl https://your-worker-url/health
```

## Architecture

- **Runtime**: Cloudflare Workers for global edge deployment
- **Language**: TypeScript with Zod validation
- **Protocol**: Model Context Protocol (MCP) for universal AI compatibility
- **APIs**: Public WordPress Trac CSV/RSS endpoints (no authentication required)

## Live Demo

**URL**: https://mcp-server-wporg-trac-staging.a8cai.workers.dev

## License

This project is licensed under the GNU General Public License v2 or later - see the [GPL License](https://www.gnu.org/licenses/gpl-3.0.en.html#license-text) for details.

## Contributing

Contributions are welcome! This server demonstrates how to build production-ready MCP servers with real-world complexity and WordPress integration.
