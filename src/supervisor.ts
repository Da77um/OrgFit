import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkEnvironment, loadManifest, parseEnvFile, type Manifest } from "./preflight";
import {
  AlertDeduplicator,
  NoSink,
  sanitizeAlerts,
  type AlertSink,
  type DeliveredAlert,
} from "./alert-delivery";

// ---------------------------------------------------------------------------
// The job supervisor (Post-Audit Repair Pass 3, audit finding 6).
//
// A portable, local runner for the scheduled jobs of deploy/processes.json.
// It is not an operating-system service and installs nothing: it runs while
// its command runs. A hosting provider's scheduler can replace it later by
// reading the same `schedule` section (P-002 is still open).
//
// What it guarantees, and how:
//
//   Separate credentials. The supervisor process holds no database URL and no
//   key — it refuses to start if its own environment has one. Each job process
//   has its own file (<env-dir>/<process>.env). The file is validated with the
//   release preflight rules (required, forbidden, key format and reuse, TLS in
//   production), then the job is started as
//       node --env-file=<that file> --import tsx <script>
//   with a minimal ambient environment, so the values are loaded by the child
//   from its own file and never pass through a combined environment. The job
//   script refuses a foreign credential again on its own (runtime-guard.ts).
//
//   Order. A group (collection: normalize → privacy processing → publication)
//   runs its jobs one after another in manifest order, every time.
//
//   No overlap. A job or group never starts while its previous run is still
//   running — including a run left behind by a supervisor that crashed, whose
//   child process ids are in status.json and are waited out. One supervisor per
//   state directory, enforced with an exclusive lock file. The routines below
//   the jobs are themselves overlap-safe (SKIP LOCKED claims, leases, advisory
//   locks, content-hash idempotency), so a second supervisor on another host
//   would be wasteful, not corrupting; running one per environment is still a
//   deployment rule.
//
//   Bounded retries. After a failure the next attempt waits retryBaseSeconds,
//   doubling, for at most maxRetries attempts; after that the job returns to its
//   normal cadence and is reported FAILING (and alerted) until it succeeds.
//
//   Timeouts and shutdown. A job past its timeout is terminated and recorded
//   TIMEOUT. On SIGINT/SIGTERM/SIGBREAK, or a STOP file in the state directory,
//   no new run starts, running jobs get shutdownGraceSeconds to finish, then
//   they are terminated and recorded INTERRUPTED; the lock is released.
//
//   Status. <state-dir>/status.json, rewritten atomically on every change: per
//   job last start, success, failure, reason, exit code, duration, consecutive
//   failures, next run. The database-side view (last success per job and the
//   backlog each drains) is recorded by the jobs themselves (023) and shown on
//   the administrator Settings screen.
//
//   Secret-safe output. Job stdout is forwarded line by line (the job scripts
//   print identifiers, counts and codes only). Job stderr is counted, not
//   forwarded, unless --show-stderr is given: a crash before a script's own
//   error handling could print a driver message that quotes a value.
// ---------------------------------------------------------------------------

export type JobSpec = {
  name: string;
  process: string;
  script: string;
  everySeconds: number;
  timeoutSeconds: number;
  group?: string;
  alerts?: boolean;
};
export type Schedule = {
  retry: { maxRetries: number; retryBaseSeconds: number };
  shutdownGraceSeconds: number;
  groups: Record<string, { everySeconds: number; jobs: string[] }>;
  jobs: Record<string, Omit<JobSpec, "name">>;
};
type SupervisorSection = { forbiddenPatterns: string[] };

export type Unit = { name: string; everySeconds: number; jobs: JobSpec[] };

export type JobState = {
  process: string;
  running: boolean;
  pid: number | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastOutcome: "SUCCESS" | "FAILURE" | null;
  lastReason: "EXIT" | "TIMEOUT" | "SPAWN_FAILED" | "INTERRUPTED" | "SKIPPED_ORPHAN" | null;
  lastExitCode: number | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
  runs: number;
  stderrLinesSuppressed: number;
};
export type UnitState = {
  running: boolean;
  nextRunAt: string;
  consecutiveFailures: number;
  health: "OK" | "RETRYING" | "FAILING" | "NEVER_RUN";
};
export type SupervisorStatus = {
  schemaVersion: 1;
  pid: number;
  startedAt: string;
  updatedAt: string;
  stopping: boolean;
  intervalScale: number;
  units: Record<string, UnitState>;
  jobs: Record<string, JobState>;
  alerts: DeliveredAlert[];
  alertDelivery: { sink: string; lastDeliveredAt: string | null; lastFailure: string | null };
};

export class SupervisorError extends Error {
  constructor(public code: string, public details: string[] = []) {
    super(code);
  }
}

// Variables a job process may inherit from the supervisor. Everything that
// identifies OrgFit comes from the job's own file.
const AMBIENT = ["PATH", "Path", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "TZ", "LOCALAPPDATA", "APPDATA"];

export function loadSchedule(manifest = loadManifest()) {
  const raw = manifest as Manifest & { schedule: Schedule; supervisor: SupervisorSection };
  if (!raw.schedule?.jobs) throw new SupervisorError("SCHEDULE_MISSING");
  return { schedule: raw.schedule, supervisor: raw.supervisor, manifest };
}

/** Groups first, in manifest order, then ungrouped jobs. */
export function unitsOf(schedule: Schedule, only?: string[]): Unit[] {
  const jobs = Object.entries(schedule.jobs).map(([name, spec]) => ({ name, ...spec }));
  const units: Unit[] = [];
  for (const [name, group] of Object.entries(schedule.groups ?? {})) {
    const members = group.jobs.map((j) => {
      const spec = jobs.find((x) => x.name === j);
      if (!spec || spec.group !== name) throw new SupervisorError("SCHEDULE_INVALID", [`group ${name}: ${j}`]);
      return spec;
    });
    units.push({ name, everySeconds: group.everySeconds, jobs: members });
  }
  for (const spec of jobs.filter((j) => !j.group)) units.push({ name: spec.name, everySeconds: spec.everySeconds, jobs: [spec] });
  return only?.length ? units.filter((u) => only.includes(u.name) || u.jobs.some((j) => only.includes(j.name))) : units;
}

/** The supervisor's own environment must hold no credential or key. */
export function assertSupervisorEnvironment(env: Record<string, string | undefined>, section: SupervisorSection) {
  const patterns = section.forbiddenPatterns.map((p) => new RegExp(p));
  const held = Object.keys(env).filter((k) => env[k] && patterns.some((p) => p.test(k)));
  if (held.length) throw new SupervisorError("SUPERVISOR_HOLDS_CREDENTIAL", held);
}

/**
 * Validate every job process's file with the preflight rules. Values are read
 * to be checked and dropped; only names and outcomes leave this function.
 */
export function validateEnvironmentFiles(envDir: string, processes: string[], manifest: Manifest) {
  const problems: string[] = [];
  const production: Record<string, boolean> = {};
  const files: Record<string, string> = {};
  for (const name of processes) {
    const file = resolve(envDir, `${name}.env`);
    if (!existsSync(file)) {
      problems.push(`${name}: ${name}.env missing`);
      continue;
    }
    const env = parseEnvFile(readFileSync(file, "utf8"));
    production[name] = env.NODE_ENV === "production";
    const findings = checkEnvironment(name, env, { production: production[name], manifest });
    for (const f of findings) if (f.outcome === "FAIL") problems.push(`${name}: ${f.check} (${f.detail})`);
    files[name] = file;
  }
  if (problems.length) throw new SupervisorError("ENVIRONMENT_INVALID", problems);
  return { files, production: Object.values(production).some(Boolean) };
}

export function childEnvironment(job: JobSpec, supervisorEnv: Record<string, string | undefined>) {
  const env: Record<string, string> = {};
  for (const key of AMBIENT) if (supervisorEnv[key]) env[key] = supervisorEnv[key]!;
  env.ORGFIT_SUPERVISED_JOB = job.name;
  return env;
}

export function nodeArguments(job: JobSpec, envFile: string) {
  return [`--env-file=${envFile}`, "--import", "tsx", job.script];
}

const pidAlive = (pid: number | null | undefined) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export type SupervisorOptions = {
  envDir: string;
  stateDir: string;
  cwd?: string;
  manifest?: Manifest;
  only?: string[];
  intervalScale?: number;
  once?: boolean;
  showStderr?: boolean;
  sink?: AlertSink;
  alertRepeatSeconds?: number;
  supervisorEnv?: Record<string, string | undefined>;
  log?: (line: string) => void;
  tickMs?: number;
  /** Overrides schedule.shutdownGraceSeconds (tests). */
  graceSeconds?: number;
  handleSignals?: boolean;
};

export class Supervisor {
  readonly units: Unit[];
  readonly schedule: Schedule;
  private files: Record<string, string> = {};
  private status!: SupervisorStatus;
  private children = new Map<string, ChildProcess>();
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private stopped: Promise<void>;
  private resolveStopped!: () => void;
  private writeChain: Promise<void> = Promise.resolve();
  private dedupe: AlertDeduplicator;
  private sink: AlertSink;
  private log: (line: string) => void;
  private scale: number;
  private lockPath: string;
  private statusPath: string;
  private supervisorAlerts: DeliveredAlert[] = [];
  private opsAlerts: DeliveredAlert[] = [];

  constructor(private options: SupervisorOptions) {
    const { schedule, supervisor, manifest } = loadSchedule(options.manifest);
    this.schedule = schedule;
    this.units = unitsOf(schedule, options.only);
    if (!this.units.length) throw new SupervisorError("NO_JOBS_SELECTED");
    const supervisorEnv = options.supervisorEnv ?? process.env;
    assertSupervisorEnvironment(supervisorEnv, supervisor);
    const processes = [...new Set(this.units.flatMap((u) => u.jobs.map((j) => j.process)))];
    const validated = validateEnvironmentFiles(options.envDir, processes, manifest);
    this.files = validated.files;
    this.scale = options.intervalScale ?? 1;
    if (this.scale !== 1 && (validated.production || supervisorEnv.NODE_ENV === "production"))
      throw new SupervisorError("INTERVAL_SCALE_NONPRODUCTION_ONLY");
    if (!(this.scale > 0 && this.scale <= 1)) throw new SupervisorError("INTERVAL_SCALE_INVALID");
    this.sink = options.sink ?? new NoSink();
    this.dedupe = new AlertDeduplicator((options.alertRepeatSeconds ?? 3600) * 1000);
    this.log = options.log ?? ((line) => console.log(line));
    this.lockPath = join(resolve(options.stateDir), "supervisor.lock");
    this.statusPath = join(resolve(options.stateDir), "status.json");
    this.stopped = new Promise((r) => (this.resolveStopped = r));
  }

  private seconds(base: number) {
    return Math.max(1, base * this.scale) * 1000;
  }

  async start() {
    await mkdir(resolve(this.options.stateDir), { recursive: true });
    await this.acquireLock();
    const previous = await readFile(this.statusPath, "utf8")
      .then((t) => JSON.parse(t) as SupervisorStatus)
      .catch(() => null);
    const now = new Date().toISOString();
    this.status = {
      schemaVersion: 1,
      pid: process.pid,
      startedAt: now,
      updatedAt: now,
      stopping: false,
      intervalScale: this.scale,
      units: {},
      jobs: {},
      alerts: [],
      alertDelivery: { sink: this.sink.kind, lastDeliveredAt: null, lastFailure: null },
    };
    for (const unit of this.units) {
      this.status.units[unit.name] = { running: false, nextRunAt: now, consecutiveFailures: 0, health: "NEVER_RUN" };
      for (const job of unit.jobs) {
        const old = previous?.jobs?.[job.name];
        this.status.jobs[job.name] = {
          process: job.process,
          running: false,
          pid: null,
          lastStartedAt: old?.lastStartedAt ?? null,
          lastFinishedAt: old?.lastFinishedAt ?? null,
          lastSuccessAt: old?.lastSuccessAt ?? null,
          lastFailureAt: old?.lastFailureAt ?? null,
          lastOutcome: old?.lastOutcome ?? null,
          lastReason: old?.lastReason ?? null,
          lastExitCode: old?.lastExitCode ?? null,
          lastDurationMs: old?.lastDurationMs ?? null,
          consecutiveFailures: old?.consecutiveFailures ?? 0,
          runs: old?.runs ?? 0,
          stderrLinesSuppressed: 0,
        };
        // A run the previous supervisor never saw finish.
        if (old?.running) {
          this.status.jobs[job.name].lastOutcome = "FAILURE";
          this.status.jobs[job.name].lastReason = "INTERRUPTED";
          this.status.jobs[job.name].lastFailureAt = now;
          if (pidAlive(old.pid)) {
            // Still running: this unit waits for it rather than overlapping.
            this.status.jobs[job.name].pid = old.pid;
            this.status.jobs[job.name].lastReason = "SKIPPED_ORPHAN";
          }
        }
      }
    }
    await this.writeStatus();
    if (this.options.handleSignals !== false)
      for (const signal of process.platform === "win32" ? (["SIGINT", "SIGBREAK"] as const) : (["SIGINT", "SIGTERM"] as const))
        process.once(signal, () => void this.stop(`signal ${signal}`));
    this.log(`supervisor started: ${this.units.map((u) => u.name).join(", ")}${this.scale !== 1 ? ` (interval scale ${this.scale})` : ""}`);
    if (this.options.once) {
      void this.runOnce();
    } else {
      this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? 1000);
      void this.tick();
    }
    return this.stopped;
  }

  private async acquireLock() {
    const body = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        await handle.writeFile(body);
        await handle.close();
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const holder = await readFile(this.lockPath, "utf8")
          .then((t) => JSON.parse(t) as { pid: number })
          .catch(() => null);
        // A live holder — including another supervisor in this same process —
        // keeps the lock. Only a dead holder's lock is stale.
        if (holder && pidAlive(holder.pid)) throw new SupervisorError("ALREADY_RUNNING");
        // The previous supervisor ended without releasing its lock.
        this.log("supervisor: removing a stale lock left by a supervisor that did not shut down");
        await rm(this.lockPath, { force: true });
      }
    }
    throw new SupervisorError("LOCK_UNAVAILABLE");
  }

  private async tick() {
    if (this.stopping) return;
    if (existsSync(join(resolve(this.options.stateDir), "STOP"))) {
      await rm(join(resolve(this.options.stateDir), "STOP"), { force: true });
      void this.stop("stop file");
      return;
    }
    const now = Date.now();
    for (const unit of this.units) {
      const state = this.status.units[unit.name];
      if (state.running || Date.parse(state.nextRunAt) > now) continue;
      // An orphan of a crashed supervisor still running: wait it out.
      const orphan = unit.jobs.find((j) => this.status.jobs[j.name].pid && !this.children.has(j.name));
      if (orphan) {
        if (pidAlive(this.status.jobs[orphan.name].pid)) continue;
        this.status.jobs[orphan.name].pid = null;
      }
      void this.runUnit(unit);
    }
  }

  private async runOnce() {
    let failed = false;
    for (const unit of this.units) {
      if (this.stopping) break;
      if (!(await this.runUnit(unit))) failed = true;
    }
    await this.stop(failed ? "once: finished with failures" : "once: finished");
    process.exitCode = failed ? 1 : 0;
  }

  /** Runs a unit's jobs in order. Returns true when every job succeeded. */
  async runUnit(unit: Unit) {
    const state = this.status.units[unit.name];
    if (state.running) return false;
    state.running = true;
    let ok = true;
    try {
      for (const job of unit.jobs) {
        if (this.stopping) {
          ok = false;
          break;
        }
        // Order is kept even after a failure: each later job is independently
        // safe (publication releases only fully processed batches), and a
        // failed normalization must not stop already closed campaigns.
        if (!(await this.runJob(job))) ok = false;
      }
    } finally {
      state.running = false;
      if (ok) {
        state.consecutiveFailures = 0;
        state.health = "OK";
        state.nextRunAt = new Date(Date.now() + this.seconds(unit.everySeconds)).toISOString();
      } else {
        state.consecutiveFailures++;
        const { maxRetries, retryBaseSeconds } = this.schedule.retry;
        const retrying = state.consecutiveFailures <= maxRetries;
        state.health = retrying ? "RETRYING" : "FAILING";
        const delay = retrying
          ? Math.min(this.seconds(retryBaseSeconds * 2 ** (state.consecutiveFailures - 1)), this.seconds(unit.everySeconds))
          : this.seconds(unit.everySeconds);
        state.nextRunAt = new Date(Date.now() + delay).toISOString();
      }
      this.refreshSupervisorAlerts();
      await this.writeStatus();
    }
    return ok;
  }

  private runJob(job: JobSpec): Promise<boolean> {
    const js = this.status.jobs[job.name];
    const started = Date.now();
    js.running = true;
    js.lastStartedAt = new Date(started).toISOString();
    js.runs++;
    void this.writeStatus();
    return new Promise((done) => {
      let child: ChildProcess;
      try {
        child = spawn(process.execPath, nodeArguments(job, this.files[job.process]), {
          cwd: this.options.cwd ?? process.cwd(),
          env: childEnvironment(job, this.options.supervisorEnv ?? process.env) as NodeJS.ProcessEnv,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        this.finishJob(job, started, "SPAWN_FAILED", null);
        done(false);
        return;
      }
      this.children.set(job.name, child);
      js.pid = child.pid ?? null;
      let stdout = "";
      let timedOut = false;
      let interrupted = false;
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        stdout += chunk;
        let at: number;
        while ((at = stdout.indexOf("\n")) >= 0) {
          const line = stdout.slice(0, at).replace(/\r$/, "");
          stdout = stdout.slice(at + 1);
          this.onJobLine(job, line);
        }
      });
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (chunk: string) => {
        const lines = chunk.split("\n").filter((l) => l.trim());
        if (this.options.showStderr) for (const l of lines) this.log(`[${job.name}] stderr: ${l.replace(/\r$/, "")}`);
        else js.stderrLinesSuppressed += lines.length;
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        this.terminate(child);
      }, job.timeoutSeconds * 1000);
      (child as ChildProcess & { orgfitInterrupt?: () => void }).orgfitInterrupt = () => {
        interrupted = true;
        this.terminate(child);
      };
      child.on("error", () => {
        /* reported through close */
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (stdout.trim()) this.onJobLine(job, stdout.replace(/\r?\n$/, ""));
        this.children.delete(job.name);
        const reason = interrupted ? "INTERRUPTED" : timedOut ? "TIMEOUT" : "EXIT";
        // ops:check exits 2 when it found a critical alert; the check itself
        // succeeded, and the alerts travel through the sink.
        const success = reason === "EXIT" && (code === 0 || (job.alerts === true && code === 2));
        this.finishJob(job, started, success ? null : reason, code);
        done(success);
      });
    });
  }

  private terminate(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    // Windows terminates on the first kill; elsewhere a job that ignores
    // SIGTERM is killed after ten seconds.
    if (process.platform !== "win32")
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 10_000).unref();
  }

  private finishJob(job: JobSpec, started: number, failure: JobState["lastReason"], code: number | null) {
    const js = this.status.jobs[job.name];
    const now = new Date().toISOString();
    js.running = false;
    js.pid = null;
    js.lastFinishedAt = now;
    js.lastDurationMs = Date.now() - started;
    js.lastExitCode = code;
    if (failure) {
      js.lastOutcome = "FAILURE";
      js.lastReason = failure;
      js.lastFailureAt = now;
      js.consecutiveFailures++;
    } else {
      js.lastOutcome = "SUCCESS";
      js.lastReason = "EXIT";
      js.lastSuccessAt = now;
      js.consecutiveFailures = 0;
    }
    this.log(
      `[${job.name}] ${failure ? `FAILURE ${failure}${code !== null ? ` exit=${code}` : ""}` : "SUCCESS"} in ${js.lastDurationMs} ms` +
        (js.stderrLinesSuppressed ? ` (${js.stderrLinesSuppressed} stderr lines not shown)` : ""),
    );
    js.stderrLinesSuppressed = 0;
    void this.writeStatus();
  }

  private onJobLine(job: JobSpec, line: string) {
    if (!line.trim()) return;
    if (job.alerts) {
      try {
        const parsed = JSON.parse(line) as { alerts?: unknown };
        if (parsed && "alerts" in parsed) {
          this.opsAlerts = sanitizeAlerts(parsed.alerts);
          void this.deliver("ops:check");
          this.log(`[${job.name}] ${this.opsAlerts.length} alert(s): ${this.opsAlerts.map((a) => `${a.severity}:${a.code}`).join(", ") || "none"}`);
          return;
        }
      } catch {
        /* not the alert line */
      }
    }
    this.log(`[${job.name}] ${line}`);
  }

  private refreshSupervisorAlerts() {
    const { maxRetries } = this.schedule.retry;
    const next: DeliveredAlert[] = [];
    for (const unit of this.units)
      for (const job of unit.jobs) {
        const js = this.status.jobs[job.name];
        if (js.consecutiveFailures > maxRetries)
          next.push({
            code: "SUPERVISED_JOB_FAILING",
            severity: job.process === "processor" ? "critical" : "warning",
            value: job.name,
          });
      }
    const changed = JSON.stringify(next) !== JSON.stringify(this.supervisorAlerts);
    this.supervisorAlerts = next;
    if (changed) void this.deliver("supervisor");
  }

  private async deliver(source: "ops:check" | "supervisor") {
    const alerts = [...this.opsAlerts, ...this.supervisorAlerts];
    this.status.alerts = alerts;
    if (!this.dedupe.shouldSend(alerts)) return;
    try {
      await this.sink.deliver({
        source,
        environment: this.options.supervisorEnv?.ORGFIT_ENVIRONMENT ?? process.env.ORGFIT_ENVIRONMENT ?? "unnamed",
        at: new Date().toISOString(),
        alerts,
      });
      if (this.sink.kind !== "none") this.status.alertDelivery.lastDeliveredAt = new Date().toISOString();
      this.status.alertDelivery.lastFailure = null;
    } catch (e) {
      // Codes only: a transport error message can include the destination URL.
      this.status.alertDelivery.lastFailure =
        e instanceof Error && /^ALERT_[A-Z_0-9]+$/.test(e.message) ? e.message : "ALERT_DELIVERY_FAILED";
      this.log(`supervisor: alert delivery failed (${this.status.alertDelivery.lastFailure})`);
    }
    await this.writeStatus();
  }

  private writeStatus() {
    this.writeChain = this.writeChain.then(async () => {
      if (!this.status) return;
      this.status.updatedAt = new Date().toISOString();
      this.status.stopping = this.stopping;
      const tmp = `${this.statusPath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(this.status, null, 2), { mode: 0o600 });
      // Windows can refuse a rename onto a file another reader holds open.
      for (let i = 0; ; i++) {
        try {
          await rename(tmp, this.statusPath);
          break;
        } catch (e) {
          if (i >= 10) throw e;
          await new Promise((r) => setTimeout(r, 25));
        }
      }
    }).catch(() => {});
    return this.writeChain;
  }

  getStatus() {
    return this.status;
  }

  async stop(reason = "requested") {
    if (this.stopping) return this.stopped;
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.log(`supervisor stopping (${reason})`);
    await this.writeStatus();
    const deadline = Date.now() + (this.options.graceSeconds ?? this.schedule.shutdownGraceSeconds) * 1000;
    while (this.children.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    for (const child of this.children.values())
      (child as ChildProcess & { orgfitInterrupt?: () => void }).orgfitInterrupt?.();
    while (this.children.size) await new Promise((r) => setTimeout(r, 50));
    for (const unit of Object.values(this.status.units)) unit.running = false;
    await this.writeStatus();
    await rm(this.lockPath, { force: true });
    this.log("supervisor stopped");
    this.resolveStopped();
    return this.stopped;
  }
}
