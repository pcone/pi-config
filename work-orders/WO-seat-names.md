# WO: seat names and roles

Carries `decisions/sessions/005-seat-names-and-roles.md` (owner 2026-11-28). Slug-only until dispatch (`rules/work-order-numbering.md`).

## Goal

Every seat has a name that survives restarts and says which seat it is: pi lanes `alpha`, `beta`, `gamma`; the Claude dispatcher `charlie`. Design work happens in rooms that any session can join.

## Today

- pi lanes run in `~/Developer/tfd` (branch `hamster`), `~/Developer/tfd-d` and `~/Developer/tfd-threading`, which has no running session. All three are separate clones of `pcone/tfd`. `~/Developer/tfd` also holds about 10 linked worktrees under `~/Developer/wt/`.
- The chat peer name is `PI_PEER_NAME`, else a name-shaped display name, else `<host>-<pid>` (`extensions/chat/index.ts` `chatIdentity`). The lanes' display names (`tfd pi`) contain a space, so they fall to host-pid. That name changes on every restart, so each restart makes a new puppet with no rooms.
- A Claude session's peer name is `claude-<session id>` (`apps/chatd/cli.ts`), with no override. Claude Code passes a session's custom name (`claude --name`, `/rename`) to the SessionStart and UserPromptSubmit hooks as `session_title`, absent when none is set (code.claude.com/docs/en/hooks.md). The SessionEnd and Notification inputs do not carry it.
- No code reads a lane directory's name; `tfd-d` appears only in comments and tests.

## Changes

1. **Directories.** Each lane clone moves to `~/Developer/tfd-<letter>`. Each running pi session reopens its own session file after the move (`pi --session <id>`), so no history is lost.
2. **A session's name is its chat name (005/4).** A pi lane starts with `pi --name <letter>`; `chatIdentity` already uses a name-shaped display name. The owner starts the dispatcher with `claude --name charlie`. The session-start and prompt hooks register `session_title`, when it is name-shaped, in place of `claude-<session id>`.
4. **Rooms.** One room per lane, `#alpha`, `#beta`, `#gamma`, holding the lane's pi orchestrator, `charlie` and the owner. One room per design concept, `#design-<concept>`, created when the concept starts. Hand-offs are @mentions in the lane room.
5. **Roles.** `charlie` dispatches from records only (APPEND_SYSTEM § Dispatch waits on the brief). A design session writes briefs and rulings and never dispatches. Neither can start a Claude session (015/39).
6. **Docs.** `docs/design/chat.md` § names states the rules; `docs/design/seat-sync.md` examples use the new paths.

## Open questions (owner)

- **Q-a, which clone becomes which letter, and what happens to `~/Developer/tfd`.** Recommended: keep `~/Developer/tfd` as the plain clone that integrates and holds worktrees, with no seat session in it. Make `tfd-alpha` a new clone for the lane running there now, and move `tfd-d` → `tfd-beta` and `tfd-threading` → `tfd-gamma`. Moving `~/Developer/tfd` itself would need `git worktree repair` across its linked worktrees.
- **Q-b, the host-pid fallback.** A name that changes every restart is a fallback the design gives no meaning to. Recommended: derive the fallback from the session id instead (`pi-<first 8 of the id>`), which is stable across restarts. The other option is to refuse to connect, naming `PI_PEER_NAME`.
- **Q-c, a name that is not name-shaped, or that changes.** A `session_title` with a space (`my feature`) is not a peer name. Recommended: slug it (lowercase, runs of other characters become `-`), the same rule for pi display names, so `tfd pi` becomes `tfd-pi`. A `/rename` mid-session changes the name at the next prompt. Recommended: the next prompt hook ends the old registration and registers the new name, so the session's rooms stay with the old puppet; a permanent session is named once at start. A second live session claiming a live name is refused at `hello`, as for pi.
- **Q-d, room creation.** Recommended: `charlie` creates the lane rooms once, and the session that opens a design concept creates its room (015 recorder's reading on channels).

## Preparatory refactor

None: the change touches one producer of each name (`chatIdentity` for pi, the hook's `self` in `apps/chatd/cli.ts` for Claude), and directory names have no reader in code.

## Acceptance

- A pi lane restarted with `pi --name alpha` reconnects as `alpha` with its rooms and levels.
- A Claude session started with `claude --name charlie` registers as `charlie`. A second live session with the same name is refused.
- With no explicit name, the fallback from Q-b gives the same name across two restarts of one session.
- `chat who` lists `alpha`, `beta`, `gamma`, `charlie` and `bug-triage`, and no `<host>-<pid>` names.
