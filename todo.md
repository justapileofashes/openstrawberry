# OpenStrawberry desktop build checklist

- [x] Create the public `openstrawberry` GitHub repository and establish protected project documentation.
- [x] Scaffold the Electron, TypeScript, and React desktop runtime with secure main/preload/renderer boundaries.
- [x] Implement the first real browser primitives: profile storage, tabs, navigation lifecycle, and native Chromium views.
- [x] Port the OpenStrawberry visual shell and agent workspace foundations into the desktop renderer.
- [x] Add architecture stubs for the vault, Companion, Orchestrator, agent registry, and installer/update configuration.
- [ ] Run static checks and build/package smoke tests, then publish source and documentation to GitHub.

## Browser-core milestone

- [x] Add durable local tab history and restore the previous window session at launch.
- [x] Add a real multi-pane split workspace with drag-targeted tab placement and pane-local navigation.
- [x] Implement a secure permissions and downloads baseline for app-owned browser profiles.
- [x] Add native picture-in-picture window scaffolding with truthful media capability detection.
- [ ] Test the browser core, package a Linux installer artifact, and publish the milestone to GitHub.
