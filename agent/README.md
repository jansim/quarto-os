# qos-agent

The in-VM helper of Quarto OS's Linux VM (`_extensions/quarto-os/vm/vm.js`).
It is a static 32-bit x86 Linux binary (CheerpX only runs i386), about 48 KB.

```sh
agent/build.sh                                  # zig on PATH
ZIG="python -m ziglang" agent/build.sh          # zig from pip (ziglang)
```

`build.sh` writes `_extensions/quarto-os/vm/qos-agent`. Commit the binary.

## How it fits together

CheerpX gives the page one control console (tty1) plus six virtual terminals
(tty2 to tty7). Their output reaches `setCustomConsole((buf, vt) => …)` tagged
with `vt`, and `send(byte, vt)` types into them.

- **tty1** runs the agent. `vm.js` puts the binary into a `DataDevice`, runs it
  from `/data` with `cx.run` (restarting it if it exits), and talks to it with a
  line protocol: STX-prefixed, LF-terminated frames, base64 payloads, and
  request ids. The full reference is at the top of `qos-agent.c`. The agent
  serves ls/stat/read/write/copy/mkdir -p/rm -r/rename, and asynchronous
  `sh -c` exec with streamed output. It also starts and supervises sessions.
  Everything runs from one `poll()` loop with output batched per wakeup.
- **tty2 to tty7** each carry one terminal session (`bash -l` as uid 1000).
  Session bytes flow directly between CheerpX and `vm.js` with no agent hop
  and no encoding. The agent only spawns the shell (setsid plus the VT as its
  controlling tty), signals it (resize, Ctrl-C, close) and reports its exit.

## CheerpX 1.4.0 quirks that shaped this

- **Only one pty.** Every `/dev/ptmx` open aliases `/dev/pts/1` (TIOCGPTN is
  always 1), so a second pty session is cross-wired with the first. That is why
  sessions use VTs, which caps them at 6.
- **VT sizes are global.** `TIOCSWINSZ` on a VT is EINVAL. The only way to set
  the size is `setCustomConsole(cb, cols, rows)`, which applies to all VTs and
  raises no SIGWINCH. `vm.js` therefore gives the VTs the size of the session
  in use (the last one written to or `activate()`d).
- **SIGWINCH kills processes that have no handler** (Linux ignores it), and
  `/proc/<pid>/status` has no SigCgt. On resize the agent only signals the
  session's login shell plus known full-screen programs (vim, nano, less, top,
  htop, …).
- **No ONLCR on VTs.** Output `\n` is not turned into `\r\n`. `Session` does
  that translation (`session.convertEol`).
- **Ctrl-C in non-canonical mode** (readline, the Python REPL) is passed
  through as a `\x03` byte instead of raising SIGINT. `vm.js` asks the agent
  (`Y`), and the agent raises SIGINT on the foreground job. Ctrl-Z and Ctrl-\
  do nothing (CheerpX: "TODO: handle SIGTSTP/SIGQUIT"), so there is no job
  suspension.
- **No process-group kills.** `kill(-pgrp)` and `killpg` give ESRCH, and
  `/proc/<pid>/stat` reports 0 for ppid/pgrp/session. `getpgid()` and
  `getsid()` do work on any pid, so groups are found by scanning `/proc`.
- `sethostname` is ENOSYS and the hostname is empty. `vm.js` patches `\h` in
  `~/.bashrc`'s PS1.
- Signal deaths are reported by bash as "Killed".
- `tcflush` is EINVAL on VTs.
- `opendir()` succeeds on regular files, so the agent checks with `stat` first.
- `chmod` fails with EACCES on a file whose mode lacks owner write (e.g. a
  `cp` from read-only `/data`).
- dash's `wait` for a background job (`sleep 1 & wait`) never returns. bash's
  works.
- In canonical mode, a ^D (VEOF) that arrives while earlier input is still
  queued is not seen as EOF (`cat` reads on). Typed by hand, it works.
- `/dev/zero` does not exist (`/dev/urandom` does).
- `mknod` is ENOSYS.
- The CloudDevice disk WebSocket is never reconnected. When a proxy drops it
  (this sandbox's proxy does after about 20 to 40 s idle), every later
  uncached read hangs forever. `vm.js` substitutes a self-healing socket for
  the disk URL: the protocol is a text header per connection, then text
  `"start-end"` requests each answered by that many bytes. The socket
  reconnects on demand and re-sends unanswered requests.
- The IndexedDB overlay is written back asynchronously, usually within 1 to
  3 s. After the very first boot of a fresh cache it takes over 4 s; 12 s was
  enough in tests. `flushIO()` and `sync` don't speed this up, so with
  `persist: true` a reload right after a change can lose it.
