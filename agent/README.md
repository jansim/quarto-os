# qos-agent

The unprivileged helper for Quarto OS's v86 Linux guest. Build the static i386
binary with Zig 0.14.1:

```sh
agent/build.sh
ZIG="python -m ziglang" agent/build.sh  # PyPI ziglang package
```

The output `_extensions/quarto-os/vm/qos-agent` is committed. The browser transfers
it through the guest's virtio 9p share and starts it on the serial console. When
started as root it drops supplementary groups, gid and uid to 1000 before handling
requests. All file operations, commands and terminal children run as `user`.

## Protocol version 3

Each frame starts with STX (`0x02`) and ends with LF. The frame is a type, request
id, optional decimal arguments and an optional base64 body, separated by spaces.
Bodies contain NUL-separated fields; `+ id base64` appends a body fragment before
its final request. Binary transfers preserve NULs. Every consumed input frame
produces `a id`: the browser must wait for that serial input credit before sending
the next frame, preventing UART overflow on large pastes and writes.

| Request | Body / response |
| --- | --- |
| `S id slot cols rows` | cwd, command, then `K=V` fields. Allocate a PTY, fork a login Bash shell, return `r id 0 pid`. Slots 2–7 are logical identifiers, not Linux VT numbers. |
| `I id` | Raw input bytes for the session; queued nonblocking on the PTY master. |
| `Z id cols rows` | `TIOCSWINSZ` on the PTY; Linux delivers SIGWINCH to its foreground group. |
| `C id` | Hang up the session; escalate to SIGKILL after a grace period. |
| `K id signal` | Signal the session or exec process and its descendants. |
| `X id` | cwd, shell command, environment. Async `sh -c`, stdout and stderr merged. |
| `L/T/R id` | List/stat/read a path. |
| `W id append` | Path, binary data; create/truncate or append. |
| `F/N id` | Copy/rename: source, destination. |
| `M/D id` | Recursive mkdir/remove. Removing `/` is refused. |
| `Q id` | Ping. |
| `B id` | Restore handshake: kill stale children, discard partial bodies/read jobs and emit hello again. |

The agent emits `h 0 3 pid` at startup, `o id base64` for PTY output, `x id code`
for terminal exit, `d id base64` for exec/read/list output, and
`r id errno number [base64]` to complete requests. Errno zero means success;
otherwise the payload is an error message. Exec completion's number is its exit
status; terminal signal deaths are `128 + signal`.

Each shell has its own controlling PTY, process group, dimensions and normal Linux
termios. Ctrl-C/Ctrl-Z are sent as bytes for the kernel line discipline. Output is
drained before exit notifications. Input queues and read budgets keep one busy
terminal from blocking unrelated terminals or filesystem operations.
