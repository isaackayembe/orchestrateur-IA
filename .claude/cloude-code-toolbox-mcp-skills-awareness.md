# Claude Code ToolBox — MCP & Skills awareness

_Generated: 2026-10-14T15:10:46.101Z_

## How to use this report

- **Saved copy:** This file is **`.claude/cloude-code-toolbox-mcp-skills-awareness.md`** — refreshed whenever the toolbox runs an MCP & Skills scan (including on workspace open when auto-scan is enabled). It is meant for **Claude Code workspace context** together with `CLAUDE.md` (which gets a shorter replaceable summary when auto-merge is on).
- **MCP:** Lists **configured** servers from Claude Code config (`~/.claude.json` for user scope, `.mcp.json` for project scope). Use `/mcp` in the Claude Code panel to connect servers for your session.
- **Skills:** **On-disk** folders with `SKILL.md`. Claude Code does not auto-load them; attach `SKILL.md` or paths in chat when useful.
- **Task routing:** When the user’s request matches a server’s purpose (e.g. Confluence → Confluence/Atlassian MCP), prefer that **server id** from the tables below.

---

## MCP — workspace

Workspace `mcp.json` _(folder: orchestrateur-ia)_

- **c:\Users\isaac.kayembe\Documents\fusion_create\orchestrateur-ia\orchestrateur-ia\.mcp.json** — _File missing_

_No active workspace servers in mcp.json._

## MCP — user profile

- **C:\Users\isaac.kayembe\.claude.json** — _File exists — servers defined_

| Server id | Kind | Detail |
|-----------|------|--------|
| 21st | http | https://21st.dev/api/mcp |

## Skills (local `SKILL.md` folders)

### Project-scoped

_None found (or no workspace open)._

### User-scoped

- **anthropic-frontend-design** — `C:\Users\isaac.kayembe\.claude\skills\anthropic-frontend-design`
  - Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one. Helps with aesthetic direction, typography, and making choices that don't read as templated defaults.

- **banner-design** — `C:\Users\isaac.kayembe\.claude\skills\banner-design`
  - Design banners for social media, ads, website heroes, creative assets, and print. Multiple art direction options with optional generated or supplied visuals. Actions: design, create, generate banner. Platforms: Facebook,

- **brand** — `C:\Users\isaac.kayembe\.claude\skills\brand`
  - Brand voice, visual identity, messaging frameworks, asset management, brand consistency. Activate for branded content, tone of voice, marketing assets, brand compliance, style guides.

- **design** — `C:\Users\isaac.kayembe\.claude\skills\design`
  - Comprehensive design skill: brand identity, design tokens, UI styling, logo generation (55 styles, Gemini, Atlas Cloud, or MuAPI AI), corporate identity program (50 deliverables, CIP mockups), HTML presentations (Chart.j

- **design-system** — `C:\Users\isaac.kayembe\.claude\skills\design-system`
  - Token architecture, component specifications, and slide generation. Three-layer tokens (primitive→semantic→component), CSS variables, spacing/typography scales, component specs, strategic slide creation. Use for design t

- **slides** — `C:\Users\isaac.kayembe\.claude\skills\slides`
  - Create strategic HTML presentations with Chart.js, design tokens, responsive layouts, copywriting formulas, and contextual slide strategies.

- **ui-styling** — `C:\Users\isaac.kayembe\.claude\skills\ui-styling`
  - Create beautiful, accessible user interfaces with shadcn/ui components (built on Radix UI + Tailwind), Tailwind CSS utility-first styling, and canvas-based visual designs. Use when building user interfaces, implementing 

- **ui-ux-pro-max** — `C:\Users\isaac.kayembe\.claude\skills\ui-ux-pro-max`
  - UI/UX design intelligence for web, mobile, and desktop. This skill should be used when designing, building, reviewing, or fixing interfaces, including pages, components, design systems, accessibility, interaction, respon

- **agent-browser** — `C:\Users\isaac.kayembe\.agents\skills\agent-browser`
  - Browser automation CLI for AI agents. Use when the user needs to interact with websites, including navigating pages, filling forms, clicking buttons, taking screenshots, extracting data, testing web apps, or automating a

- **cross-review** — `C:\Users\isaac.kayembe\.agents\skills\cross-review`
  - Cross review code using a subagent with a specified model. Use when the user asks to review code changes AND specifies a model to use (e.g., 'review with opus', 'use sonnet to review', 'review changes with gemini'). The 

- **frontend-design** — `C:\Users\isaac.kayembe\.agents\skills\frontend-design`
  - Design distinctive, production-grade frontend interfaces — mockups as HTML pages or working application pages. Use when the user asks to design a web page, landing page, UI mockup, dashboard, application page, or any vis

- **init** — `C:\Users\isaac.kayembe\.agents\skills\init`
  - Use when the user asks to initialize a repo, create AGENTS.md, generate contributor guidelines, or set up agent-oriented documentation for a codebase.

- **plan** — `C:\Users\isaac.kayembe\.agents\skills\plan`
  - Planning agent for task breakdown and implementation planning. Use via spawn_subagent with skill='plan' when you need to explore a codebase and design an implementation approach before writing code.

- **research** — `C:\Users\isaac.kayembe\.agents\skills\research`
  - Fast agent specialized for exploring codebases and searching for code patterns. Use via spawn_subagent with skill='research' for read-only exploration tasks.

- **skill-creator** — `C:\Users\isaac.kayembe\.agents\skills\skill-creator`
  - Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill pe

- **zen-comprehensive-review** — `C:\Users\isaac.kayembe\.agents\skills\zen-comprehensive-review`
  - Orchestrate a multi-model code review: spawn 3 review subagents, merge findings. In PR mode, posts GitHub PR comments. In local mode, outputs findings directly. CRITICAL: this skill is costly, don't use it unless user ex

- **zen-review** — `C:\Users\isaac.kayembe\.agents\skills\zen-review`
  - Expert code reviewer. Analyze PR changes for correctness, security, performance, and quality. Returns findings as JSON. CRITICAL: this skill is costly, don't use it unless user explicitly requested to use it.

---

## Suggested next steps

- **MCP:** Use this extension’s hub **MCP** tab, or `claude mcp list` in the terminal. In Claude Code, use `/mcp` to connect servers for the session.
- **Edit config:** Open `~/.claude.json` (user MCP) or `<workspace>/.mcp.json` (project MCP) via the extension commands.
- **Refresh this report:** run **Intelligence — scan MCP & Skills awareness** again after changing MCP config or adding skills.

_Report from Claude Code ToolBox extension._
