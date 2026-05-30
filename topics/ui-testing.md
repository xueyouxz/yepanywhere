# UI Testing

This topic codifies visual QA for client layout regressions in settings and session controls.

## Principle

When a UI control change affects spacing, grouping, or interaction semantics, the bug report is considered **done** only after a real browser screenshot is captured and reviewed by a human.

## Browser-first check protocol

1. Start the app UI and reproduce the target path in a real browser.
2. Open the settings page and navigate to the edited panel.
3. Take screenshots at:
   - a desktop/large viewport width,
   - narrow mobile width (`375x812` or equivalent).
4. Visually inspect each screenshot and confirm:
   - control row and descriptive text are grouped together,
   - active control state is visually clear,
   - no element overflows or crowds the row.
5. Archive reviewed screenshots under a readable path (for example,
   `.artifacts/ui-testing/<yyyy-mm-dd>-<topic>/...`), and reference the
   file names in the task note.
6. Leave a short reviewer note in the task about what changed and what was
   visually confirmed.

## Recommended automation

Preferred: use the browser control tool listed in `CLAUDE.md`:

```bash
cd ~/code/claw-starter
npx tsx lib/browser/server.ts &
npx tsx lib/browser-cli.ts open http://localhost:3400/
npx tsx lib/browser-cli.ts snapshot --efficient
npx tsx lib/browser-cli.ts screenshot
```

### If `claw-starter` is not available yet

Use any available browser automation path (Playwright/Selenium) or a manual browser session:

1. Open the target page directly in a browser.
2. Resize viewport to desktop + mobile dimensions.
3. Capture screenshots via the tool or OS-level capture.
4. Attach the files where reviewers can review them directly.

## Verification acceptance checklist

- [ ] A single logical setting row does not span a control row and its status/explanation.
- [ ] A setting change has a matching explanatory text line directly below the control row.
- [ ] Preset buttons remain clickable and clearly indicate the current selection.
- [ ] Layout works on at least one mobile width without horizontal overflow.
- [ ] A screenshot from a browser session was captured and reviewed.
