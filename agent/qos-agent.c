/*
 * qos-agent — the in-VM helper of Quarto OS.
 *
 * CheerpX gives the page one control console (tty1) plus six more virtual
 * terminals (tty2..tty7) whose bytes the page reads and writes directly
 * (console callback `vt` argument / `send(byte, vt)`). This agent runs on
 * tty1 and provides everything else from one poll() loop: it starts and
 * supervises terminal sessions on the VTs, and serves filesystem operations
 * and asynchronous `sh -c` executions, so a long exec or a big file read
 * never blocks terminal traffic.
 *
 * Why VTs and not ptys: in CheerpX 1.4.0 every open of /dev/ptmx yields the
 * same pty (/dev/pts/1), so a second pty session would be cross-wired with
 * the first. VTs are independent ttys with termios and job control.
 *
 * Wire protocol (version 2). Both directions are line oriented; every frame
 * starts with STX (0x02) and ends with LF. Anything outside a frame (kernel
 * messages, \r inserted by a cooked tty, echo) is ignored by the receiver.
 * Binary payloads are base64; numbers are decimal.
 *
 *   JS -> agent   "\x02" T " " id [" " num]* [" " b64] "\n"   (T upper case or '+')
 *   agent -> JS   "\x02" t " " id [" " num]* [" " b64] "\n"   (t lower case)
 *
 * Requests whose payload ("body") would make a line long are split: any number
 * of "+ id b64" lines append to the body of request `id`, then the request
 * line itself follows (its optional trailing b64 is appended too). Body
 * fields are separated by NUL bytes.
 *
 *   + id b64        append to body of request id
 *   S id vt         start a session on /dev/tty<vt>; body: cwd \0 cmd \0 K=V ...
 *                   (empty cmd = login shell)                   -> r id 0 pid
 *   Z id            the terminal size changed: SIGWINCH to the session's shell and
 *                   foreground full-screen programs (no reply; see session_winch)
 *   Y id            Ctrl-C typed: if the tty has ISIG but is non-canonical (CheerpX
 *                   then passes ^C through as data) send SIGINT to the foreground
 *                   job -> r id 0 1; otherwise -> r id 0 0 (page sends the byte)
 *   C id            close session (SIGHUP, then SIGKILL)        -> x frame
 *   K id sig        signal every process of session/exec id
 *   L id            list dir; body: path        -> d frames, r id 0 count
 *   T id            stat; body: path            -> r id 0 0 b64(record)
 *   R id            read file; body: path       -> d frames, r id 0 size
 *   W id append     write file; body: path \0 data              -> r id 0 size
 *   F id            copy file; body: src \0 dst                 -> r id 0 size
 *   M id            mkdir -p; body: path
 *   D id            rm -r (missing path is not an error); body: path
 *   N id            rename; body: from \0 to
 *   X id            exec sh -c; body: cwd \0 cmd \0 K=V ...
 *                   -> d frames (stdout+stderr), r id 0 exitcode
 *   Q id            ping -> r id 0
 *
 *   h 0 version pid       hello, sent once at start-up
 *   x id code             session ended (exit status or 128+signal)
 *   d id b64              data chunk belonging to request id
 *   r id errno num [b64]  request finished; errno 0 = success, otherwise b64
 *                         carries strerror(errno)
 *
 * Directory records (L) and stat records (T) are "type/size/mtime_ms/mode/name"
 * joined by NUL; type is f, d, o or l followed by the link target's type
 * (lf, ld, lo, l- for a dangling link). Names never contain '/' or NUL.
 *
 * Other CheerpX quirks handled here (see agent/README.md): VT sizes are global
 * and changing them raises no SIGWINCH, and SIGWINCH kills processes without a
 * handler; kill(-pgrp) is not supported (we scan /proc and compare
 * getpgid()/getsid()); opendir() succeeds on regular files.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#define PROTO_VERSION 2
#define VT_FIRST 2           /* session terminals: /dev/tty2 .. /dev/tty7 */
#define VT_LAST 7
#define MAX_KIDS 64          /* sessions + execs alive at once */
#define MAX_BODIES 32        /* requests with a body in flight */
#define MAX_RJOBS 16         /* concurrent file reads */
#define FRAME_RAW 12288      /* max raw bytes per output frame (16 KB base64) */
#define READ_BUDGET 65536    /* max bytes read from one fd per loop iteration */
#define EXEC_GRACE_MS 200    /* wait for pipe EOF after an exec child exited */
#define EXEC_POLL_MS 100     /* re-check exec pipes this often (see main loop) */
#define CLOSE_KILL_MS 300    /* SIGKILL a closed session after this delay */

static const char *HOME = "/home/user";
static const char *DEFAULT_ENV[] = {
    "HOME=/home/user", "USER=user", "LOGNAME=user", "SHELL=/bin/bash",
    "TERM=xterm-256color", "LANG=C.UTF-8",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", NULL};

/* ------------------------------------------------------------------------ */
/* Small utilities                                                          */
/* ------------------------------------------------------------------------ */

typedef struct {
  char *p;
  size_t len, cap;
} buf_t;

static void buf_reserve(buf_t *b, size_t extra) {
  if (b->len + extra <= b->cap) return;
  size_t c = b->cap ? b->cap : 1024;
  while (c < b->len + extra) c *= 2;
  char *np = realloc(b->p, c);
  if (!np) abort();
  b->p = np;
  b->cap = c;
}
static void buf_add(buf_t *b, const void *d, size_t n) {
  buf_reserve(b, n);
  memcpy(b->p + b->len, d, n);
  b->len += n;
}
static void buf_free(buf_t *b) {
  free(b->p);
  b->p = NULL;
  b->len = b->cap = 0;
}

static double now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

static const char B64[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static signed char B64REV[256];

static void b64_init(void) {
  memset(B64REV, -1, sizeof B64REV);
  for (int i = 0; i < 64; i++) B64REV[(unsigned char)B64[i]] = i;
}

/* Encodes n bytes; dst needs 4*ceil(n/3) bytes. Returns encoded length. */
static size_t b64_enc(char *dst, const unsigned char *s, size_t n) {
  char *d = dst;
  size_t i = 0;
  for (; i + 2 < n; i += 3) {
    unsigned v = s[i] << 16 | s[i + 1] << 8 | s[i + 2];
    *d++ = B64[v >> 18];
    *d++ = B64[v >> 12 & 63];
    *d++ = B64[v >> 6 & 63];
    *d++ = B64[v & 63];
  }
  if (i < n) {
    unsigned v = s[i] << 16 | (i + 1 < n ? s[i + 1] << 8 : 0);
    *d++ = B64[v >> 18];
    *d++ = B64[v >> 12 & 63];
    *d++ = i + 1 < n ? B64[v >> 6 & 63] : '=';
    *d++ = '=';
  }
  return d - dst;
}

/* Decodes, skipping anything that is not a base64 digit (including '='). */
static size_t b64_dec(unsigned char *dst, const char *s, size_t n) {
  unsigned v = 0;
  int bits = 0;
  size_t o = 0;
  for (size_t i = 0; i < n; i++) {
    int c = B64REV[(unsigned char)s[i]];
    if (c < 0) continue;
    v = v << 6 | c;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      dst[o++] = v >> bits;
    }
  }
  return o;
}

/* ------------------------------------------------------------------------ */
/* Output frames. Everything is buffered and written once per loop wakeup.  */
/* ------------------------------------------------------------------------ */

static buf_t out;

static void out_num(long v) {
  char t[24];
  int n = snprintf(t, sizeof t, " %ld", v);
  buf_add(&out, t, n);
}
static void frame_begin(char type, long id) {
  char t[32];
  int n = snprintf(t, sizeof t, "\x02%c %ld", type, id);
  buf_add(&out, t, n);
}
static void frame_b64(const void *d, size_t n) {
  buf_reserve(&out, 1 + (n + 2) / 3 * 4);
  out.p[out.len++] = ' ';
  out.len += b64_enc(out.p + out.len, d, n);
}
static void frame_end(void) { buf_add(&out, "\n", 1); }

/* Emits `data` as a sequence of 'd' frames, FRAME_RAW bytes each. */
static void data_frames(long id, const void *data, size_t n) {
  const char *p = data;
  while (n > 0) {
    size_t k = n < FRAME_RAW ? n : FRAME_RAW;
    frame_begin('d', id);
    frame_b64(p, k);
    frame_end();
    p += k;
    n -= k;
  }
}

static void reply(long id, int err, long num, const void *d, size_t n) {
  frame_begin('r', id);
  out_num(err);
  out_num(num);
  if (n) frame_b64(d, n);
  frame_end();
}
static void reply_ok(long id, long num) { reply(id, 0, num, NULL, 0); }
static void reply_err(long id, int err) {
  if (!err) err = EIO;
  const char *m = strerror(err);
  reply(id, err, 0, m, strlen(m));
}

static void flush_out(void) {
  size_t off = 0;
  while (off < out.len) {
    ssize_t k = write(1, out.p + off, out.len - off);
    if (k > 0) {
      off += k;
    } else if (k < 0 && (errno == EINTR || errno == EAGAIN)) {
      if (errno == EAGAIN) {
        struct pollfd p = {1, POLLOUT, 0};
        poll(&p, 1, 100);
      }
    } else {
      _exit(3); /* console gone */
    }
  }
  out.len = 0;
  if (out.cap > (1 << 20)) buf_free(&out); /* don't keep a huge buffer */
}

/* ------------------------------------------------------------------------ */
/* Children (sessions and execs), read jobs, request bodies                 */
/* ------------------------------------------------------------------------ */

enum { K_FREE, K_SESSION, K_EXEC };

typedef struct {
  int kind;
  long id;
  pid_t pid;
  int fd;            /* exec: pipe read end; session: our handle on /dev/ttyN */
  int vt;            /* session: VT number */
  int alive;         /* not reaped yet */
  int status;        /* wait status once reaped */
  double reaped_at;  /* exec: start of the EOF grace period */
  double kill_at;    /* session: SIGKILL deadline after close, 0 = none */
} kid_t;

static kid_t kids[MAX_KIDS];
static struct termios vt_sane[VT_LAST + 1]; /* initial termios of each VT */
static int vt_have_sane[VT_LAST + 1];

typedef struct {
  long id;
  int fd;
  long total;
} rjob_t;
static rjob_t rjobs[MAX_RJOBS];
static int nrjobs;

typedef struct {
  long id;
  buf_t b;
} body_t;
static body_t bodies[MAX_BODIES];

static kid_t *kid_find(long id) {
  for (int i = 0; i < MAX_KIDS; i++)
    if (kids[i].kind != K_FREE && kids[i].id == id) return &kids[i];
  return NULL;
}
static kid_t *kid_new(void) {
  for (int i = 0; i < MAX_KIDS; i++)
    if (kids[i].kind == K_FREE) return &kids[i];
  return NULL;
}
static void kid_free(kid_t *k) {
  if (k->fd >= 0) close(k->fd);
  memset(k, 0, sizeof *k);
  k->fd = -1;
}

static buf_t *body_get(long id) {
  for (int i = 0; i < MAX_BODIES; i++)
    if (bodies[i].id == id) return &bodies[i].b;
  for (int i = 0; i < MAX_BODIES; i++)
    if (!bodies[i].id) {
      bodies[i].id = id;
      return &bodies[i].b;
    }
  return NULL;
}
static void body_drop(long id) {
  for (int i = 0; i < MAX_BODIES; i++)
    if (bodies[i].id == id) {
      buf_free(&bodies[i].b);
      bodies[i].id = 0;
    }
}

/* Splits a NUL separated body into at most max fields (the dispatcher appends
 * a terminating NUL). Returns the field count. */
static int body_fields(buf_t *b, char **f, int max) {
  int n = 0;
  size_t i = 0;
  while (n < max && i < b->len) {
    f[n++] = b->p + i;
    i += strlen(b->p + i) + 1;
  }
  return n;
}

/* ------------------------------------------------------------------------ */
/* Signals and process groups                                               */
/* ------------------------------------------------------------------------ */

static int sigpipe_fds[2] = {-1, -1};

static void on_sigchld(int s) {
  (void)s;
  int e = errno;
  if (write(sigpipe_fds[1], "c", 1) < 0) { /* pipe full: already woken */ }
  errno = e;
}

/* CheerpX has no kill(-pgrp): find members through /proc + getpgid/getsid.
 * by_session != 0 selects getsid() == val, otherwise getpgid() == val.
 * Returns the number of processes signalled. */
static int signal_group(pid_t val, int by_session, int sig) {
  int n = 0;
  if (val <= 0) return 0;
  DIR *d = opendir("/proc");
  if (d) {
    struct dirent *e;
    pid_t self = getpid();
    while ((e = readdir(d))) {
      pid_t p = atoi(e->d_name);
      if (p <= 1 || p == self) continue;
      pid_t g = by_session ? getsid(p) : getpgid(p);
      if (g == val && kill(p, sig) == 0) n++;
    }
    closedir(d);
  }
  if (!n && kill(val, sig) == 0) n++;
  return n;
}

/* Signals the foreground job of a session's terminal (or the whole session). */
static void signal_foreground(kid_t *k, int sig) {
  pid_t fg = k->fd >= 0 ? tcgetpgrp(k->fd) : -1;
  if (fg <= 0 || !signal_group(fg, 0, sig)) signal_group(k->pid, 1, sig);
}

/* Reads the command name of pid p ("comm", from /proc/p/stat). */
static int proc_name(pid_t p, char *name, size_t size) {
  char path[32], buf[128];
  snprintf(path, sizeof path, "/proc/%d/stat", p);
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return 0;
  ssize_t n = read(fd, buf, sizeof buf - 1);
  close(fd);
  if (n <= 0) return 0;
  buf[n] = 0;
  char *a = strchr(buf, '('), *b = strrchr(buf, ')');
  if (!a || !b || b <= a || (size_t)(b - a - 1) >= size) return 0;
  memcpy(name, a + 1, b - a - 1);
  name[b - a - 1] = 0;
  return 1;
}

/* CheerpX terminates a process that receives SIGWINCH without a handler
 * (Linux ignores it), and /proc has no SigCgt to tell. So the new size is
 * announced only to the session's interactive shell and to well-known
 * full-screen programs that always handle SIGWINCH. */
static const char *WINCH_OK[] = {
    "vim", "vi", "vim.basic", "vim.tiny", "nvim", "nano", "less", "more", "most", "man",
    "top", "htop", "watch", "mc", "emacs", "tmux", "screen", "w3m", "lynx", "links",
    "elinks", "tig", "ncdu", "alsamixer", "dialog", "whiptail", NULL};

static void session_winch(kid_t *k) {
  pid_t fg = k->fd >= 0 ? tcgetpgrp(k->fd) : -1;
  DIR *d = opendir("/proc");
  if (!d) return;
  struct dirent *e;
  while ((e = readdir(d))) {
    pid_t p = atoi(e->d_name);
    if (p <= 1 || getsid(p) != k->pid) continue;
    int ok = p == k->pid; /* the login shell (readline redraws the prompt) */
    char name[32];
    if (!ok && fg > 0 && getpgid(p) == fg && proc_name(p, name, sizeof name))
      for (int i = 0; WINCH_OK[i] && !ok; i++) ok = !strcmp(name, WINCH_OK[i]);
    if (ok) kill(p, SIGWINCH);
  }
  closedir(d);
}

/* Restores default signal state in a freshly forked child. */
static void child_signals(void) {
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = SIG_DFL;
  for (int s = 1; s < NSIG; s++) sigaction(s, &sa, NULL);
  sigset_t set;
  sigemptyset(&set);
  sigprocmask(SIG_SETMASK, &set, NULL);
}

/* Closes every descriptor above 2 in a child (agent fds are CLOEXEC anyway). */
static void child_close_fds(void) {
  long max = sysconf(_SC_OPEN_MAX);
  if (max < 0 || max > 4096) max = 4096;
  for (int fd = 3; fd < max; fd++) close(fd);
}

/* Builds the child environment: defaults overridden by K=V fields. */
static char **make_env(char **extra, int nextra) {
  int n = 0;
  while (DEFAULT_ENV[n]) n++;
  char **env = calloc(n + nextra + 1, sizeof *env);
  int m = 0;
  for (int i = 0; i < n; i++) env[m++] = (char *)DEFAULT_ENV[i];
  for (int i = 0; i < nextra; i++) {
    char *eq = strchr(extra[i], '=');
    if (!eq || eq == extra[i]) continue;
    size_t kl = eq - extra[i] + 1;
    int j;
    for (j = 0; j < m; j++)
      if (!strncmp(env[j], extra[i], kl)) break;
    env[j] = extra[i];
    if (j == m) m++;
  }
  env[m] = NULL;
  return env;
}

static int is_dir(const char *p) {
  struct stat st;
  return p && *p && stat(p, &st) == 0 && S_ISDIR(st.st_mode);
}

static int exit_code(int st) {
  if (WIFEXITED(st)) return WEXITSTATUS(st);
  if (WIFSIGNALED(st)) return 128 + WTERMSIG(st);
  return 255;
}

/* ------------------------------------------------------------------------ */
/* Sessions (one per VT)                                                    */
/* ------------------------------------------------------------------------ */

static void op_session(long id, int vt, buf_t *body) {
  char *f[64];
  int nf = body_fields(body, f, 64);
  const char *cwd = nf > 0 ? f[0] : "";
  const char *cmd = nf > 1 ? f[1] : "";
  if (vt < VT_FIRST || vt > VT_LAST) return reply_err(id, EINVAL);
  for (int i = 0; i < MAX_KIDS; i++)
    if (kids[i].kind == K_SESSION && kids[i].vt == vt) return reply_err(id, EBUSY);
  kid_t *k = kid_new();
  if (!k) return reply_err(id, EAGAIN);
  char dev[16];
  snprintf(dev, sizeof dev, "/dev/tty%d", vt);
  int h = open(dev, O_RDWR | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
  if (h < 0) return reply_err(id, errno);
  /* Discard input a previous session left unread (tcflush is EINVAL on VTs).
   * The page sends nothing for this session before our reply. */
  char junk[256];
  while (read(h, junk, sizeof junk) > 0) {}
  char **env = make_env(f + 2, nf > 2 ? nf - 2 : 0);
  pid_t pid = fork();
  if (pid < 0) {
    int e = errno;
    close(h);
    free(env);
    return reply_err(id, e);
  }
  if (pid == 0) {
    child_signals();
    setsid();
    int s = open(dev, O_RDWR); /* first tty opened by a session leader: ctty */
    if (s < 0) _exit(126);
    ioctl(s, TIOCSCTTY, 0);
    if (vt_have_sane[vt]) tcsetattr(s, TCSANOW, &vt_sane[vt]); /* undo a crashed raw-mode app */
    dup2(s, 0);
    dup2(s, 1);
    dup2(s, 2);
    child_close_fds();
    tcsetpgrp(0, getpid());
    if (!is_dir(cwd) || chdir(cwd) != 0) {
      if (*cwd) dprintf(2, "qos: %s: no such directory, starting in %s\r\n", cwd, HOME);
      if (chdir(HOME) != 0 && chdir("/") != 0) _exit(126);
    }
    if (*cmd) {
      char *argv[] = {"bash", "-lc", (char *)cmd, NULL};
      execve("/bin/bash", argv, env);
    } else {
      char *argv[] = {"bash", "-l", NULL};
      execve("/bin/bash", argv, env);
    }
    dprintf(2, "qos: cannot run bash: %s\r\n", strerror(errno));
    _exit(127);
  }
  free(env);
  k->kind = K_SESSION;
  k->id = id;
  k->pid = pid;
  k->fd = h;
  k->vt = vt;
  k->alive = 1;
  reply_ok(id, pid);
}

/* Ctrl-C: CheerpX turns VINTR into SIGINT only in canonical mode. With ISIG
 * set in non-canonical mode (readline, the Python REPL, less, top) we raise
 * SIGINT ourselves; otherwise the page writes the byte as usual. */
static void op_interrupt(long id) {
  kid_t *k = kid_find(id);
  struct termios t;
  if (!k || k->kind != K_SESSION || !k->alive || tcgetattr(k->fd, &t) != 0) return reply_ok(id, 0);
  if (!(t.c_lflag & ISIG) || (t.c_lflag & ICANON) || t.c_cc[VINTR] != 3) return reply_ok(id, 0);
  signal_foreground(k, SIGINT);
  reply_ok(id, 1);
}

static void op_close(long id) {
  kid_t *k = kid_find(id);
  if (!k || k->kind != K_SESSION || !k->alive) return;
  signal_group(k->pid, 1, SIGHUP);
  kill(k->pid, SIGCONT);
  k->kill_at = now_ms() + CLOSE_KILL_MS;
}

static void op_kill(long id, int sig) {
  kid_t *k = kid_find(id);
  if (!k || !k->alive) return;
  if (sig <= 0 || sig >= NSIG) sig = SIGTERM;
  signal_group(k->pid, 1, sig);
}

/* ------------------------------------------------------------------------ */
/* Exec                                                                     */
/* ------------------------------------------------------------------------ */

static void op_exec(long id, buf_t *body) {
  char *f[64];
  int nf = body_fields(body, f, 64);
  const char *cwd = nf > 0 && *f[0] ? f[0] : HOME;
  const char *cmd = nf > 1 ? f[1] : "";
  if (!is_dir(cwd)) return reply_err(id, errno ? errno : ENOTDIR);
  kid_t *k = kid_new();
  if (!k) return reply_err(id, EAGAIN);
  int p[2];
  if (pipe2(p, O_CLOEXEC) < 0) return reply_err(id, errno);
  char **env = make_env(f + 2, nf > 2 ? nf - 2 : 0);
  pid_t pid = fork();
  if (pid < 0) {
    int e = errno;
    close(p[0]);
    close(p[1]);
    free(env);
    return reply_err(id, e);
  }
  if (pid == 0) {
    child_signals();
    setsid();
    int dn = open("/dev/null", O_RDONLY);
    dup2(dn >= 0 ? dn : p[1], 0);
    dup2(p[1], 1);
    dup2(p[1], 2);
    child_close_fds();
    if (chdir(cwd) != 0) _exit(126);
    char *argv[] = {"sh", "-c", (char *)cmd, NULL};
    execve("/bin/sh", argv, env);
    dprintf(2, "qos: cannot run /bin/sh: %s\n", strerror(errno));
    _exit(127);
  }
  free(env);
  close(p[1]);
  fcntl(p[0], F_SETFL, O_NONBLOCK);
  k->kind = K_EXEC;
  k->id = id;
  k->pid = pid;
  k->fd = p[0];
  k->alive = 1;
}

/* Reads available exec output into 'd' frames. Returns 0 on EOF. */
static int drain_exec(kid_t *k, size_t budget) {
  static unsigned char rb[READ_BUDGET];
  size_t got = 0;
  while (k->fd >= 0 && got < budget) {
    ssize_t r = read(k->fd, rb, sizeof rb < budget - got ? sizeof rb : budget - got);
    if (r > 0) {
      data_frames(k->id, rb, r);
      got += r;
    } else if (r < 0 && errno == EINTR) {
      continue;
    } else if (r < 0 && errno == EAGAIN) {
      return 1;
    } else {
      return 0; /* EOF or error */
    }
  }
  return 1;
}

/* ------------------------------------------------------------------------ */
/* Filesystem operations                                                    */
/* ------------------------------------------------------------------------ */

static char type_char(mode_t m) {
  return S_ISREG(m) ? 'f' : S_ISDIR(m) ? 'd' : S_ISLNK(m) ? 'l' : 'o';
}

static int add_stat(buf_t *b, const struct stat *st, const char *t, const char *label) {
  long long ms = (long long)st->st_mtim.tv_sec * 1000 + st->st_mtim.tv_nsec / 1000000;
  char head[96];
  int n = snprintf(head, sizeof head, "%s/%lld/%lld/%o/", t, (long long)st->st_size, ms,
                   (unsigned)(st->st_mode & 07777));
  buf_add(b, head, n);
  buf_add(b, label, strlen(label) + 1);
  return 0;
}

/* Appends "type/size/mtime/mode/name\0" for `name` relative to dirfd. */
static int add_record(buf_t *b, int dirfd, const char *name, const char *label) {
  struct stat st, ts;
  if (fstatat(dirfd, name, &st, AT_SYMLINK_NOFOLLOW) != 0) return -1;
  char t[3] = {type_char(st.st_mode), 0, 0};
  if (t[0] == 'l') t[1] = fstatat(dirfd, name, &ts, 0) == 0 ? type_char(ts.st_mode) : '-';
  return add_stat(b, &st, t, label);
}

static void op_ls(long id, const char *path) {
  struct stat st;
  if (stat(path, &st) != 0) return reply_err(id, errno);
  if (!S_ISDIR(st.st_mode)) return reply_err(id, ENOTDIR); /* CheerpX opendir()s files */
  DIR *d = opendir(path);
  if (!d) return reply_err(id, errno);
  buf_t b = {0};
  long count = 0;
  struct dirent *e;
  while ((e = readdir(d))) {
    const char *n = e->d_name;
    if (n[0] == '.' && (!n[1] || (n[1] == '.' && !n[2]))) continue;
    if (add_record(&b, dirfd(d), n, n) == 0) count++;
  }
  closedir(d);
  data_frames(id, b.p, b.len);
  buf_free(&b);
  reply_ok(id, count);
}

/* Like stat(2): describes what a symlink points to, unless it dangles. */
static void op_stat(long id, const char *path) {
  buf_t b = {0};
  struct stat st;
  if (stat(path, &st) == 0) {
    char t[2] = {type_char(st.st_mode), 0};
    add_stat(&b, &st, t, "");
  } else if (add_record(&b, AT_FDCWD, path, "") != 0) {
    return reply_err(id, errno);
  }
  reply(id, 0, 0, b.p, b.len);
  buf_free(&b);
}

static void op_read(long id, const char *path) {
  if (nrjobs >= MAX_RJOBS) return reply_err(id, EAGAIN);
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_NONBLOCK);
  if (fd < 0) return reply_err(id, errno);
  struct stat st;
  if (fstat(fd, &st) == 0 && S_ISDIR(st.st_mode)) {
    close(fd);
    return reply_err(id, EISDIR);
  }
  fcntl(fd, F_SETFL, 0);
  rjobs[nrjobs++] = (rjob_t){id, fd, 0};
}

/* Streams a slice of every pending read; returns 1 if reads remain. */
static int pump_reads(void) {
  static unsigned char rb[READ_BUDGET];
  for (int i = 0; i < nrjobs;) {
    rjob_t *j = &rjobs[i];
    ssize_t r = read(j->fd, rb, sizeof rb);
    if (r > 0) {
      data_frames(j->id, rb, r);
      j->total += r;
      i++;
      continue;
    }
    if (r < 0 && errno == EINTR) continue;
    if (r < 0) reply_err(j->id, errno);
    else reply_ok(j->id, j->total);
    close(j->fd);
    rjobs[i] = rjobs[--nrjobs];
  }
  return nrjobs > 0;
}

static int write_all(int fd, const char *p, size_t n) {
  while (n) {
    ssize_t w = write(fd, p, n);
    if (w < 0 && errno == EINTR) continue;
    if (w <= 0) return -1;
    p += w;
    n -= w;
  }
  return 0;
}

static void op_write(long id, int append, buf_t *body) {
  size_t pl = strnlen(body->p, body->len);
  if (pl == 0 || pl + 2 > body->len) return reply_err(id, EINVAL);
  const char *data = body->p + pl + 1;
  size_t n = body->len - pl - 2; /* minus path NUL and the dispatcher's NUL */
  int fd = open(body->p, O_WRONLY | O_CREAT | O_CLOEXEC | (append ? O_APPEND : O_TRUNC), 0644);
  if (fd < 0) return reply_err(id, errno);
  int rc = write_all(fd, data, n);
  int e = errno;
  if (close(fd) != 0 && rc == 0) rc = -1, e = errno;
  if (rc) return reply_err(id, e);
  reply_ok(id, n);
}

static void op_copy(long id, const char *src, const char *dst) {
  int in = open(src, O_RDONLY | O_CLOEXEC);
  if (in < 0) return reply_err(id, errno);
  int o = open(dst, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
  if (o < 0) {
    int e = errno;
    close(in);
    return reply_err(id, e);
  }
  static char cb[65536];
  long total = 0;
  int err = 0;
  for (;;) {
    ssize_t r = read(in, cb, sizeof cb);
    if (r < 0 && errno == EINTR) continue;
    if (r < 0) { err = errno; break; }
    if (r == 0) break;
    if (write_all(o, cb, r)) { err = errno; break; }
    total += r;
  }
  close(in);
  if (close(o) != 0 && !err) err = errno;
  if (err) return reply_err(id, err);
  reply_ok(id, total);
}

static int mkdir_p(char *path) {
  for (char *p = path + 1; *p; p++) {
    if (*p != '/') continue;
    *p = 0;
    int r = mkdir(path, 0755);
    *p = '/';
    if (r != 0 && errno != EEXIST) return -1;
  }
  if (mkdir(path, 0755) != 0) {
    if (errno != EEXIST) return -1;
    if (!is_dir(path)) return errno = ENOTDIR, -1;
  }
  return 0;
}

static int rm_r(const char *path) {
  struct stat st;
  if (lstat(path, &st) != 0) return errno == ENOENT ? 0 : -1;
  if (!S_ISDIR(st.st_mode)) return unlink(path);
  DIR *d = opendir(path);
  if (!d) return -1;
  struct dirent *e;
  int rc = 0;
  size_t pl = strlen(path);
  while ((e = readdir(d))) {
    const char *n = e->d_name;
    if (n[0] == '.' && (!n[1] || (n[1] == '.' && !n[2]))) continue;
    char *c = malloc(pl + strlen(n) + 2);
    sprintf(c, "%s/%s", path, n);
    if (rm_r(c) != 0) rc = -1;
    free(c);
  }
  closedir(d);
  if (rc) return -1;
  return rmdir(path);
}

/* ------------------------------------------------------------------------ */
/* Request dispatch                                                         */
/* ------------------------------------------------------------------------ */

static void dispatch(char *s, size_t n) {
  /* s points just after STX; tokens are separated by single spaces. */
  char *tok[8];
  int nt = 0;
  char *p = s, *end = s + n;
  while (p < end && nt < 8) {
    tok[nt++] = p;
    char *sp = memchr(p, ' ', end - p);
    if (!sp) sp = end;
    *sp = 0;
    p = sp + 1;
  }
  if (nt < 2 || strlen(tok[0]) != 1) return;
  char t = tok[0][0];
  long id = strtol(tok[1], NULL, 10);
  if (id <= 0) return;

  /* Number of numeric arguments after the id, per request type. */
  int nnum = (t == 'S' || t == 'K' || t == 'W') ? 1 : 0;
  long num = nnum && nt > 2 ? strtol(tok[2], NULL, 10) : 0;
  char *b64 = nt > 2 + nnum ? tok[2 + nnum] : NULL;
  size_t b64len = b64 ? strlen(b64) : 0;

  switch (t) { /* requests without a body */
    case 'Z': { kid_t *k = kid_find(id); if (k && k->kind == K_SESSION && k->alive) session_winch(k); return; }
    case 'Y': return op_interrupt(id);
    case 'C': return op_close(id);
    case 'K': return op_kill(id, num);
    case 'Q': return reply_ok(id, 0);
  }

  /* Everything else carries a body: collect it (plus the inline piece). */
  buf_t *b = body_get(id);
  if (!b) return reply_err(id, EAGAIN);
  if (b64len) {
    buf_reserve(b, b64len / 4 * 3 + 3);
    b->len += b64_dec((unsigned char *)b->p + b->len, b64, b64len);
  }
  if (t == '+') return;
  buf_add(b, "", 1); /* NUL-terminate the last field */

  char *f[2] = {"", ""};
  body_fields(b, f, 2);
  switch (t) {
    case 'S': op_session(id, num, b); break;
    case 'X': op_exec(id, b); break;
    case 'L': op_ls(id, f[0]); break;
    case 'T': op_stat(id, f[0]); break;
    case 'R': op_read(id, f[0]); break;
    case 'W': op_write(id, num, b); break;
    case 'F': op_copy(id, f[0], f[1]); break;
    case 'M':
      if (!*f[0]) reply_err(id, EINVAL);
      else if (mkdir_p(f[0]) != 0) reply_err(id, errno);
      else reply_ok(id, 0);
      break;
    case 'D':
      if (!*f[0] || !strcmp(f[0], "/")) reply_err(id, EPERM);
      else if (rm_r(f[0]) != 0) reply_err(id, errno);
      else reply_ok(id, 0);
      break;
    case 'N':
      if (rename(f[0], f[1]) != 0) reply_err(id, errno);
      else reply_ok(id, 0);
      break;
    default: reply_err(id, ENOSYS);
  }
  body_drop(id);
}

/* Feeds raw console input; dispatches complete STX..LF frames. */
static void feed_input(buf_t *in) {
  size_t start = 0;
  for (;;) {
    char *nl = memchr(in->p + start, '\n', in->len - start);
    if (!nl) break;
    size_t ln = nl - (in->p + start);
    char *line = in->p + start;
    /* Ignore anything before the last STX on the line (stray bytes). */
    char *stx = memrchr(line, 0x02, ln);
    if (stx) {
      size_t off = stx + 1 - line;
      size_t fl = ln - off;
      while (fl && line[off + fl - 1] == '\r') fl--;
      dispatch(line + off, fl);
    }
    start += ln + 1;
  }
  if (start) {
    memmove(in->p, in->p + start, in->len - start);
    in->len -= start;
  }
  if (in->len > (8 << 20)) in->len = 0; /* runaway line without LF: drop */
}

/* ------------------------------------------------------------------------ */
/* Main loop                                                                */
/* ------------------------------------------------------------------------ */

static void reap(void) {
  int st;
  pid_t p;
  while ((p = waitpid(-1, &st, WNOHANG)) > 0) {
    for (int i = 0; i < MAX_KIDS; i++) {
      kid_t *k = &kids[i];
      if (k->kind != K_FREE && k->alive && k->pid == p) {
        k->alive = 0;
        k->status = st;
        k->reaped_at = now_ms();
      }
    }
    /* Unknown pids are orphans re-parented to us (we may be pid 1). */
  }
}

int main(void) {
  b64_init();
  for (int i = 0; i < MAX_KIDS; i++) kids[i].fd = -1;
  umask(022);
  if (chdir(HOME) != 0 && chdir("/") != 0) return 2;

  /* Raw console: no echo, no CR/LF translation, no signals. The protocol is
   * designed to survive a cooked console too, this just makes it cheaper. */
  struct termios t;
  if (tcgetattr(0, &t) == 0) {
    cfmakeraw(&t);
    t.c_cc[VMIN] = 1;
    t.c_cc[VTIME] = 0;
    tcsetattr(0, TCSANOW, &t);
  }
  fcntl(0, F_SETFL, fcntl(0, F_GETFL) | O_NONBLOCK);

  /* Remember each VT's pristine settings so sessions start sane. */
  for (int vt = VT_FIRST; vt <= VT_LAST; vt++) {
    char dev[16];
    snprintf(dev, sizeof dev, "/dev/tty%d", vt);
    int fd = open(dev, O_RDWR | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
    if (fd >= 0) {
      vt_have_sane[vt] = tcgetattr(fd, &vt_sane[vt]) == 0 && (vt_sane[vt].c_lflag & ICANON);
      close(fd);
    }
  }

  signal(SIGPIPE, SIG_IGN);
  signal(SIGHUP, SIG_IGN);
  signal(SIGINT, SIG_IGN);
  signal(SIGQUIT, SIG_IGN);
  signal(SIGTTOU, SIG_IGN);
  signal(SIGTTIN, SIG_IGN);
  signal(SIGTSTP, SIG_IGN);
  if (pipe2(sigpipe_fds, O_NONBLOCK | O_CLOEXEC) != 0) return 2;
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = on_sigchld;
  sa.sa_flags = SA_RESTART | SA_NOCLDSTOP;
  sigaction(SIGCHLD, &sa, NULL);

  frame_begin('h', 0);
  out_num(PROTO_VERSION);
  out_num(getpid());
  frame_end();
  flush_out();

  buf_t in = {0};
  struct pollfd pfd[2 + MAX_KIDS];

  for (;;) {
    /* Poll the console, the SIGCHLD pipe and exec pipes; work out how long
     * we may sleep. Exec pipes are also re-read on a short timer because
     * CheerpX's poll() does not always report data that arrived while we
     * were not sleeping in poll(). */
    int np = 0;
    pfd[np++] = (struct pollfd){0, POLLIN, 0};
    pfd[np++] = (struct pollfd){sigpipe_fds[0], POLLIN, 0};
    int timeout = -1, alive = 0;
    double now = now_ms();
    for (int i = 0; i < MAX_KIDS; i++) {
      kid_t *k = &kids[i];
      if (k->kind == K_FREE) continue;
      if (k->alive) alive = 1;
      int due_ms = -1;
      if (k->kind == K_EXEC && k->fd >= 0) {
        pfd[np++] = (struct pollfd){k->fd, POLLIN, 0};
        due_ms = EXEC_POLL_MS;
      }
      if (k->kind == K_EXEC && !k->alive) {
        double due = k->reaped_at + EXEC_GRACE_MS;
        due_ms = due > now ? (int)(due - now) + 1 : 0;
      }
      if (k->kind == K_SESSION && k->alive && k->kill_at) {
        due_ms = k->kill_at > now ? (int)(k->kill_at - now) + 1 : 0;
      }
      if (due_ms >= 0 && (timeout < 0 || due_ms < timeout)) timeout = due_ms;
    }
    if (nrjobs) timeout = 0;
    /* Fallback in case a SIGCHLD ever gets lost: re-check children. */
    if (alive && (timeout < 0 || timeout > 2000)) timeout = 2000;

    int n = poll(pfd, np, timeout);
    if (n < 0 && errno != EINTR) _exit(4);

    if (n > 0 && pfd[1].revents) {
      char tmp[64];
      while (read(sigpipe_fds[0], tmp, sizeof tmp) > 0) {}
    }
    reap();

    /* Console input: read everything that is there (non-blocking). */
    for (;;) {
      buf_reserve(&in, 65536);
      ssize_t r = read(0, in.p + in.len, 65536);
      if (r > 0) {
        in.len += r;
        continue;
      }
      if (r == 0) _exit(0); /* console closed */
      if (errno != EINTR && errno != EAGAIN) _exit(0);
      break;
    }
    feed_input(&in);

    /* Exec output (regardless of revents, see above). */
    for (int i = 0; i < MAX_KIDS; i++) {
      kid_t *k = &kids[i];
      if (k->kind == K_EXEC && k->fd >= 0 && !drain_exec(k, READ_BUDGET)) {
        close(k->fd);
        k->fd = -1;
      }
    }

    /* Finished children. */
    now = now_ms();
    for (int i = 0; i < MAX_KIDS; i++) {
      kid_t *k = &kids[i];
      if (k->kind == K_SESSION && k->alive && k->kill_at && now >= k->kill_at) {
        signal_group(k->pid, 1, SIGKILL);
        k->kill_at = now + 1000;
      }
      if (k->alive || k->kind == K_FREE) continue;
      if (k->kind == K_SESSION) {
        /* Leftover background jobs would keep writing into a VT that the
         * next session reuses: end them with their shell. */
        signal_group(k->pid, 1, SIGKILL);
        frame_begin('x', k->id);
        out_num(exit_code(k->status));
        frame_end();
        kid_free(k);
      } else if (k->fd < 0 || now >= k->reaped_at + EXEC_GRACE_MS) {
        drain_exec(k, 1 << 20);
        reply_ok(k->id, exit_code(k->status));
        kid_free(k);
      }
    }

    pump_reads();
    if (out.len) flush_out();
  }
}
