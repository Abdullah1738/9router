#!/usr/bin/env node
// Zero-downtime supervisor for a standalone 9router build.
//
// The primary process owns the listen socket and runs one worker from the
// release that RELEASE_DIR (usually a `current` symlink) points to. SIGHUP
// reloads: fork a worker from the release RELEASE_DIR points to now, wait
// until it answers /api/health itself, then tell the old worker to drain.
// The old worker stops accepting connections, finishes its in-flight
// requests (long LLM streams included) and exits. Clients never see a refused
// connection or a cut stream. If the new worker fails, the old one keeps
// serving.
//
// Env: RELEASE_DIR (required), PORT, HOSTNAME, NODE_EXEC_ARGV (space
// separated), DRAIN_MAX_MS (default 20 min), READY_TIMEOUT_MS (default 120 s).
// Run it with `node scripts/cluster-supervisor.cjs`; it never loads app code.

const cluster = require("cluster");
const fs = require("fs");
const http = require("http");
const path = require("path");

const RELEASE_DIR = process.env.RELEASE_DIR;
if (!RELEASE_DIR) {
  console.error("[9r-supervisor] RELEASE_DIR is required");
  process.exit(1);
}
const PORT = Number(process.env.PORT) || 20128;
const HEALTH_HOST = !process.env.HOSTNAME || process.env.HOSTNAME === "0.0.0.0" ? "127.0.0.1" : process.env.HOSTNAME;
const EXEC_ARGV = (process.env.NODE_EXEC_ARGV || "--dns-result-order=ipv4first --max-old-space-size=6144")
  .split(/\s+/)
  .filter(Boolean);
const DRAIN_MAX_MS = Number(process.env.DRAIN_MAX_MS) || 20 * 60 * 1000;
const READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS) || 120 * 1000;
const SHUTDOWN_DRAIN_MS = 15 * 1000; // launchd SIGKILLs 20 s after SIGTERM

const log = (msg) => console.log(`[9r-supervisor] ${new Date().toISOString()} ${msg}`);

let active = null; // worker serving traffic
let reloading = false;
let reloadQueued = false;
let shuttingDown = false;
let crashTimes = [];

function forkFromCurrentRelease() {
  const release = fs.realpathSync(RELEASE_DIR);
  const entry = path.join(release, "custom-server.js");
  if (!fs.existsSync(entry)) throw new Error(`no custom-server.js in ${release}`);
  cluster.setupPrimary({ exec: entry, cwd: release, execArgv: EXEC_ARGV });
  const worker = cluster.fork();
  worker.release = release;
  log(`forked worker ${worker.process.pid} from ${release}`);
  return worker;
}

// Ask /api/health until the reply carries this worker's pid. The primary
// round-robins connections, so other workers may answer some probes.
function waitUntilServing(worker) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const onExit = () => reject(new Error(`worker ${worker.process.pid} exited before serving`));
    worker.once("exit", onExit);
    const done = (fn, value) => {
      worker.off("exit", onExit);
      fn(value);
    };
    const probe = () => {
      if (Date.now() > deadline) return done(reject, new Error(`worker ${worker.process.pid} not serving after ${READY_TIMEOUT_MS} ms`));
      const req = http.get(
        { host: HEALTH_HOST, port: PORT, path: "/api/health", agent: false, timeout: 10000, headers: { connection: "close" } },
        (res) => {
          res.resume();
          const servedBy = res.headers["x-9r-worker"];
          if (res.statusCode === 200 && servedBy === String(worker.process.pid)) return done(resolve);
          setTimeout(probe, 200);
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => setTimeout(probe, 500));
    };
    worker.once("listening", probe);
  });
}

function drain(worker, maxMs) {
  if (!worker || worker.isDead() || worker.draining) return;
  worker.draining = true;
  log(`draining worker ${worker.process.pid} (max ${Math.round(maxMs / 1000)} s)`);
  try {
    worker.send({ type: "9r:drain", maxMs });
  } catch {
    worker.process.kill("SIGTERM");
  }
  // Backstop in case the worker ignores the drain.
  setTimeout(() => {
    if (!worker.isDead()) {
      log(`worker ${worker.process.pid} still alive after drain window, killing`);
      worker.process.kill("SIGKILL");
    }
  }, maxMs + 15000).unref();
}

async function reload(reason) {
  if (shuttingDown) return;
  if (reloading) {
    reloadQueued = true;
    return;
  }
  reloading = true;
  log(`reload requested (${reason})`);
  let next;
  try {
    next = forkFromCurrentRelease();
    await waitUntilServing(next);
    const previous = active;
    active = next;
    log(`worker ${next.process.pid} serving; release ${next.release}`);
    if (previous) drain(previous, DRAIN_MAX_MS);
  } catch (err) {
    log(`reload failed: ${err.message}; keeping worker ${active ? active.process.pid : "none"}`);
    if (next && !next.isDead()) next.process.kill("SIGKILL");
    if (!active) setTimeout(() => reload("retry after failed start"), 5000);
  } finally {
    reloading = false;
    if (reloadQueued) {
      reloadQueued = false;
      reload("queued");
    }
  }
}

cluster.on("exit", (worker, code, signal) => {
  log(`worker ${worker.process.pid} exited (${signal || code})${worker.draining ? " after drain" : ""}`);
  if (shuttingDown) {
    if (Object.keys(cluster.workers).length === 0) process.exit(0);
    return;
  }
  if (worker !== active) return;
  active = null;
  const now = Date.now();
  crashTimes = crashTimes.filter((t) => now - t < 60000).concat(now);
  const delay = crashTimes.length > 3 ? 10000 : 500;
  log(`active worker died, restarting in ${delay} ms`);
  setTimeout(() => reload("active worker died"), delay);
});

process.on("SIGHUP", () => reload("SIGHUP"));
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${sig}: draining all workers and exiting`);
    const workers = Object.values(cluster.workers);
    if (workers.length === 0) process.exit(0);
    for (const w of workers) {
      w.draining = false;
      drain(w, SHUTDOWN_DRAIN_MS);
    }
    setTimeout(() => process.exit(0), SHUTDOWN_DRAIN_MS + 3000).unref();
  });
}

log(`pid ${process.pid}, port ${PORT}, release dir ${RELEASE_DIR}`);
reload("startup");
