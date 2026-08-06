# Local development

Use Wrangler to run the Worker on your computer. Local development does not require a Cloudflare account or credentials.

## Requirements

- Node.js 22 or later.
- pnpm 10.

Install the dependencies:

```bash
pnpm install
```

## Start the Worker

Run:

```bash
pnpm dev
```

Keep that terminal open. Wrangler will build the Worker, watch the source files, and print:

```text
[wrangler:info] Ready on http://localhost:8787
```

## Open the browser test page

Press `b` in the Wrangler terminal, or open [http://localhost:8787/](http://localhost:8787/) yourself. The root route is a browser-visible landing page that lists the MCP tools and shows local connection examples.

After editing `src/index.ts`, wait for Wrangler to rebuild and refresh the page. The browser examples should continue to use the origin you started on; they do not change a deployed environment.

Open [http://localhost:8787/health](http://localhost:8787/health) in another tab. It should show:

```text
OK
```

You can run the same health check from another terminal:

```bash
curl --fail http://localhost:8787/health
```

Press `Ctrl+C` in the Wrangler terminal to stop the server.

## Troubleshooting

### The browser cannot connect

Confirm the Wrangler terminal is still open and shows the `Ready` message. Restart `pnpm dev` if the process stopped.

### Port 8787 is already in use

Choose another port:

```bash
pnpm exec wrangler dev --port 8788
```

Then open `http://localhost:8788/` and `http://localhost:8788/health`.

### The runtime or dependencies do not match

Check the installed versions and restore the locked dependencies:

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
```

## Before opening a pull request

Run the complete local gate:

```bash
pnpm check
```

If your change affects MCP transport or live Trac parsing, also follow the [manual smoke test](smoke-test.md).
