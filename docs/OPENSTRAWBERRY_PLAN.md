# OpenStrawberry product plan

## What this is

A local-first desktop browser for macOS, Windows, and Linux providing real
Chromium browsing, browser-native AI Companions, review-first multi-agent
orchestration, per-agent encrypted credentials, provider API and local coding
CLI support, split workspaces, privacy-aware migration, and user-controlled
updates.

## Inspiration and boundaries

The product is inspired by the *publicly observable* workflow patterns of
browser-native AI companions: explicit selected browsing context, planning
before action, user-visible delegation, background progress, approval before
side effects, durable artifacts, and local-first data boundaries.

OpenStrawberry does not claim to know, reproduce, or reverse-engineer any other
product's private implementation. These are original, transparent equivalents.

The visual system draws general lessons — density, hierarchy, monochrome
contrast, control sizing, interaction state — from publicly visible products. No
third-party artwork, brand expression, screenshots, code, or product-specific
layout is reproduced.

## Design system: Obsidian Relay

A warm-monochrome near-black workspace with restrained white and grey hierarchy,
compact tool surfaces, cool-tinted Liquid Glass on chrome only, and motion that
communicates state rather than decorating it.

The base ramp is warm; glass is deliberately cooler, so chrome reads as glass
laid over warm content rather than as another warm surface. Colour is reserved
for meaning, never decoration.

Rules:

1. Near-black shell, clear white and grey typography, achromatic-first palette.
2. Selective monochrome Liquid Glass on chrome, compact controls, tooltips, the
   Agent rail, update panel, migration flow, settings, and approval surfaces.
   Webpage content stays readable and content-first — never glassed.
3. Tab rail on the left, favicons only, with a safe globe fallback and a loading
   indicator.
4. Workspace controls on the top bar, icon-first, with hover and keyboard-focus
   text bubbles.
5. Agent rail and Updates triggers are icon-only, with accessible names retained.
6. Motion and Liquid Glass are always on. No user-facing toggles.
7. Short, interruptible transitions on transform and opacity, visible focus
   states, and `prefers-reduced-motion` support for non-essential movement.
8. Desktop-first, but responsive and keyboard accessible.
9. On Windows, remove the default application menu while preserving native
   title-bar controls.

## Agent model

Companions are browser-native, not a generic chat screen. The user selects and
inspects browser context before it is shared. Every agent task presents a
reviewable plan naming its context, expected artifacts, likely side effects,
approvals, budgets, and current status.

The Orchestrator builds a typed, visible task graph for roles such as
Researcher, Coder, and Reviewer, preserving dependencies, bounded context
grants, approval gates, budgets, artifacts, cancellation, and explicit `blocked`
and `needs-user` states. There is no opaque hidden swarm.

Provider calls and local CLI runs happen only in the main process. CLI
executables are allowlisted, their environment restricted, and their inputs and
execution policy bounded. The renderer can never supply an executable path or a
shell command.

## Status

See [`../todo.md`](../todo.md) for the working checklist and
[`RELEASES.md`](RELEASES.md) for release posture.

| Milestone | State |
|---|---|
| M0 Scaffold | Complete |
| M1 Trust boundary | Complete |
| M2 Real browsing | Complete |
| M3 Obsidian Relay chrome | Substantially complete; fonts not yet bundled |
| M4 Browser fundamentals | Not started |
| M5 Migration and password staging | Not started |
| M6 Agents and orchestration | Not started |
| M7 Updater | Not started |
| M8 Icons and packaging | Not started |
| M9 Release readiness | Blocked on signing credentials |

Implemented work and planned work are distinguished deliberately. Nothing above
is marked complete before `pnpm check`, `pnpm test`, and `pnpm build` pass and
the milestone's own validation runs.
