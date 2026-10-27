# Claude Code — project context


<!-- cloude-code-toolbox:mcp-skills-awareness-begin -->

### MCP & Skills awareness (Claude Code ToolBox)

_Last synced: 2026-10-27T16:20:17.543Z._

- **Full report:** `.claude/cloude-code-toolbox-mcp-skills-awareness.md` in this workspace (auto-overwritten on each scan). Use it as ground truth for configured servers and skill folders.
- **MCP:** For **live tools** in Claude Code, enable the matching server via `/mcp`. Servers are configured in `~/.claude.json` (user) and `.mcp.json` (project).
- **When the user’s task matches a server** (e.g. Confluence work and a **Confluence** / **Atlassian** MCP is listed), **prefer that server id** and plan on tool use—not only file search.
- **Skills:** Folders below contain `SKILL.md`; attach or cite paths in chat when relevant.

#### Workspace MCP

- `c:\Users\isaac.kayembe\Documents\fusion_create\orchestrateur-ia\orchestrateur-ia\.mcp.json` _(workspace: orchestrateur-ia)_ — _file missing_

_No active workspace servers in mcp.json._

#### User MCP

- `C:\Users\isaac.kayembe\.claude.json` — _servers defined_

| Server id | Kind | Detail |
|-----------|------|--------|
| 21st | http | https://21st.dev/api/mcp |

#### Project skills

_None found (or no workspace open)._

#### User skills

- **anthropic-frontend-design** — `C:\Users\isaac.kayembe\.claude\skills\anthropic-frontend-design` — Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one. Helps with aesthetic direction, typography, and making choices that don't read as templated defaults.

- **banner-design** — `C:\Users\isaac.kayembe\.claude\skills\banner-design` — Design banners for social media, ads, website heroes, creative assets, and print. Multiple art direction options with optional generated or supplied visuals. Actions: design, create, generate banner. Platforms: Facebook,

- **brand** — `C:\Users\isaac.kayembe\.claude\skills\brand` — Brand voice, visual identity, messaging frameworks, asset management, brand consistency. Activate for branded content, tone of voice, marketing assets, brand compliance, style guides.

- **design** — `C:\Users\isaac.kayembe\.claude\skills\design` — Comprehensive design skill: brand identity, design tokens, UI styling, logo generation (55 styles, Gemini, Atlas Cloud, or MuAPI AI), corporate identity program (50 deliverables, CIP mockups), HTML presentations (Chart.j

- **design-system** — `C:\Users\isaac.kayembe\.claude\skills\design-system` — Token architecture, component specifications, and slide generation. Three-layer tokens (primitive→semantic→component), CSS variables, spacing/typography scales, component specs, strategic slide creation. Use for design t

- **slides** — `C:\Users\isaac.kayembe\.claude\skills\slides` — Create strategic HTML presentations with Chart.js, design tokens, responsive layouts, copywriting formulas, and contextual slide strategies.

- **ui-styling** — `C:\Users\isaac.kayembe\.claude\skills\ui-styling` — Create beautiful, accessible user interfaces with shadcn/ui components (built on Radix UI + Tailwind), Tailwind CSS utility-first styling, and canvas-based visual designs. Use when building user interfaces, implementing 

- **ui-ux-pro-max** — `C:\Users\isaac.kayembe\.claude\skills\ui-ux-pro-max` — UI/UX design intelligence for web, mobile, and desktop. This skill should be used when designing, building, reviewing, or fixing interfaces, including pages, components, design systems, accessibility, interaction, respon

- **agent-browser** — `C:\Users\isaac.kayembe\.agents\skills\agent-browser` — Browser automation CLI for AI agents. Use when the user needs to interact with websites, including navigating pages, filling forms, clicking buttons, taking screenshots, extracting data, testing web apps, or automating a

- **cross-review** — `C:\Users\isaac.kayembe\.agents\skills\cross-review` — Cross review code using a subagent with a specified model. Use when the user asks to review code changes AND specifies a model to use (e.g., 'review with opus', 'use sonnet to review', 'review changes with gemini'). The 

- **frontend-design** — `C:\Users\isaac.kayembe\.agents\skills\frontend-design` — Design distinctive, production-grade frontend interfaces — mockups as HTML pages or working application pages. Use when the user asks to design a web page, landing page, UI mockup, dashboard, application page, or any vis

- **init** — `C:\Users\isaac.kayembe\.agents\skills\init` — Use when the user asks to initialize a repo, create AGENTS.md, generate contributor guidelines, or set up agent-oriented documentation for a codebase.

- **plan** — `C:\Users\isaac.kayembe\.agents\skills\plan` — Planning agent for task breakdown and implementation planning. Use via spawn_subagent with skill='plan' when you need to explore a codebase and design an implementation approach before writing code.

- **research** — `C:\Users\isaac.kayembe\.agents\skills\research` — Fast agent specialized for exploring codebases and searching for code patterns. Use via spawn_subagent with skill='research' for read-only exploration tasks.

- **skill-creator** — `C:\Users\isaac.kayembe\.agents\skills\skill-creator` — Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill pe

- **zen-comprehensive-review** — `C:\Users\isaac.kayembe\.agents\skills\zen-comprehensive-review` — Orchestrate a multi-model code review: spawn 3 review subagents, merge findings. In PR mode, posts GitHub PR comments. In local mode, outputs findings directly. CRITICAL: this skill is costly, don't use it unless user ex

- **zen-review** — `C:\Users\isaac.kayembe\.agents\skills\zen-review` — Expert code reviewer. Analyze PR changes for correctness, security, performance, and quality. Returns findings as JSON. CRITICAL: this skill is costly, don't use it unless user explicitly requested to use it.

<!-- cloude-code-toolbox:mcp-skills-awareness-end -->
