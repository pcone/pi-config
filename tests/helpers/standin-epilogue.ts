// Stand-in `pi` fixtures hold their RPC pipe open with a keepalive timer, so
// they never exit on their own: a stand-in whose test file finished keeps a
// whole bun runtime alive. One suite run left 34 of them, ~5 MB each, ten hours
// old and reparented to launchd.
//
// Every stand-in appends this epilogue so it dies with its spawner.
//
// Liveness is a signal-0 probe, not `process.ppid`: bun caches ppid at startup,
// so a reparented stand-in still reports its original parent and a
// ppid-changed check never fires (verified on bun 1.3.11; node updates it).
export const STANDIN_EPILOGUE = `
// Exit when the process that spawned this stand-in is gone.
const spawner = process.ppid;
const spawnerAlive = () => {
	try { process.kill(spawner, 0); return true; } catch { return false; }
};
setInterval(() => { if (!spawnerAlive()) process.exit(0); }, 500).unref?.();
`;
