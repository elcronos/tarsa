# Open file in editor (VS Code / Cursor / Zed)

## Goal
When a tool call shows a file path, clicking it should open the file in the user's editor.

## Files to touch
- `src/server.ts` — new endpoint `POST /api/open-in-editor` with `{ path, line?, col? }`
- `frontend/src/utils/openInEditor.ts` (NEW) — calls endpoint
- File-path components in tool-call views — wrap in clickable link

## Acceptance
- Endpoint shells out via `child_process.spawn` to: `code -g`, `cursor -g`, or `zed` — auto-detect by `which` at startup, cache result
- If none found → return 503 with helpful error; frontend shows toast "No editor found"
- Path validated: must be absolute, must exist, must be inside a project directory (no `/etc/passwd` etc.)
- Frontend: cursor changes on hover over file paths in tool call views
- `npm test && npm run build` pass

## Notes
Editor preference order: env `EDITOR` override → cursor → code → zed.
Validate path is absolute + exists + not a symlink to outside cwd before spawn.
