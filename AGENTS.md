# Playground

The heymax family app for making the work: a design canvas whose documents are real HTML and CSS, with a hosted MCP server agents edit through. Blue in the family. Live at playground.heymax.im.

- Run: `npm install`, `npm run dev` (API on :4000, client on :5173). See README.md for headless rendering and storage options.
- Check: `npm run typecheck`, `npm test` (runs `kit:check` first).
- Deploy: Coolify from this repo's Dockerfile; health is `GET /api/health`. Each push to main is a deploy.
- Kit: the shared files are listed in `kit.json` and copied from `../kit`; never edit them here. `node ../kit/scripts/sync.mjs . --write` updates them.
- Rules for every heymax app: `../kit/docs/standards.md`. Design notes for this app: DESIGN.md.
- MCP: hosted at `/mcp/<code>`; tool names are snake_case `verb_noun`.
