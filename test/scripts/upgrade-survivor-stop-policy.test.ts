import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const owner = resolve("scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh");
function fixture() {
  const home = tempDirs.make("survivor-stop-policy-");
  const env = { HOME: home, npm_config_prefix: home, PATH: process.env.PATH };
  const installed = spawnSync(
    "bash",
    [
      "-c",
      'set -euo pipefail; source "$1"; install_update_restart_systemctl_shim',
      "fixture",
      owner,
    ],
    { env, encoding: "utf8" },
  );
  expect(installed.status, installed.stderr).toBe(0);
  const unit = join(home, ".config/systemd/user/openclaw-gateway.service");
  mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
  const systemctl = (...args: string[]) =>
    spawnSync(join(home, "bin/systemctl"), ["--user", ...args], { env, encoding: "utf8" });
  const manager = (...args: string[]) =>
    spawnSync(process.execPath, [join(home, "bin/systemd-fixture.mjs"), ...args], {
      env,
      encoding: "utf8",
    });
  return { home, env, unit, systemctl, manager };
}

describe.skipIf(process.platform === "win32")("survivor loaded stop policy", () => {
  it("reports the loaded stop policy until daemon-reload", () => {
    const { unit, systemctl, manager } = fixture();
    const query = () =>
      systemctl(
        "show",
        "openclaw-gateway.service",
        "--no-page",
        "--property",
        "LoadState,TimeoutStopUSec",
      );
    expect(query().stdout).toBe("LoadState=not-found\n");
    const content = "[Service]\nExecStart=/usr/bin/true\nTimeoutStopSec=330\n";
    writeFileSync(unit, content);
    expect(systemctl("daemon-reload").status).toBe(0);
    expect(query()).toMatchObject({
      status: 0,
      stdout: "LoadState=loaded\nTimeoutStopUSec=330s\n",
    });
    expect(manager("stop-timeout-ms").stdout).toBe("330000\n");
    writeFileSync(unit, content.replace("TimeoutStopSec=330", "TimeoutStopSec=30"));
    expect(query().stdout).toContain("TimeoutStopUSec=330s");
    expect(manager("stop-timeout-ms").stdout).toBe("330000\n");
    expect(systemctl("daemon-reload").status).toBe(0);
    expect(query().stdout).toContain("TimeoutStopUSec=30s");
    expect(manager("stop-timeout-ms").stdout).toBe("30000\n");
    writeFileSync(unit, content.replace("TimeoutStopSec=330", "TimeoutStopSec=invalid"));
    expect(systemctl("daemon-reload").status).not.toBe(0);
    expect(query().stdout).toContain("TimeoutStopUSec=30s");
    expect(manager("stop-timeout-ms").stdout).toBe("30000\n");
    rmSync(unit);
    const runtime = systemctl(
      "show",
      "openclaw-gateway.service",
      "--property",
      "Id,LoadState,ActiveState,SubState,Result,NRestarts,StartLimitBurst,MainPID,ExecMainStatus,ExecMainCode,KillMode,TasksCurrent,MemoryCurrent",
    );
    expect(runtime.status, runtime.stderr).toBe(0);
    expect(runtime.stdout).toContain("LoadState=loaded");
    expect(query().stdout).toContain("TimeoutStopUSec=30s");
    expect(systemctl("daemon-reload").status).toBe(0);
    expect(query().stdout).toBe("LoadState=not-found\n");
    expect(manager("stop-timeout-ms").status).not.toBe(0);
  });

  it.each([
    { policy: "", value: "90000", display: "90s" },
    { policy: "TimeoutStopSec=0", value: "Infinity", display: "infinity" },
    { policy: "TimeoutStopSec=infinity", value: "Infinity", display: "infinity" },
  ])("handles generated stop policy $policy deliberately", ({ policy, value, display }) => {
    const { unit, systemctl, manager } = fixture();
    writeFileSync(unit, "[Service]\nExecStart=/usr/bin/true\n" + policy + "\n");
    expect(systemctl("daemon-reload").status).toBe(0);
    expect(manager("stop-timeout-ms")).toMatchObject({ status: 0, stdout: value + "\n" });
    expect(
      systemctl("show", "openclaw-gateway.service", "--property=LoadState,TimeoutStopUSec").stdout,
    ).toBe("LoadState=loaded\nTimeoutStopUSec=" + display + "\n");
  });

  it.each(["-1", "bogus", "1ms", "2147484", "9".repeat(400), "30\nTimeoutStopSec=330"])(
    "refuses unsupported stop policy %j at load",
    (policy) => {
      const { unit, systemctl } = fixture();
      writeFileSync(unit, "[Service]\nExecStart=/usr/bin/true\nTimeoutStopSec=" + policy + "\n");
      expect(systemctl("daemon-reload").status).not.toBe(0);
      expect(existsSync(unit + ".loaded-unit")).toBe(false);
    },
  );

  // Execute the unchanged supervisor body with native boundaries substituted. The
  // virtual clock advances policy-sized deadlines without launching or killing PIDs.
  it.each([30, 330, "infinity"] as const)(
    "uses loaded %s seconds for supervisor and outer stop",
    (seconds) => {
      const f = fixture();
      writeFileSync(f.unit, "[Service]\nExecStart=/usr/bin/true\nTimeoutStopSec=" + seconds + "\n");
      expect(f.systemctl("daemon-reload").status).toBe(0);
      // An un-reloaded edit must not affect either consumer.
      writeFileSync(f.unit, "[Service]\nExecStart=/usr/bin/true\nTimeoutStopSec=1\n");
      if (seconds === 330) {
        writeFileSync(f.unit, "[Service]\nExecStart=/usr/bin/true\nTimeoutStopSec=30\n");
        expect(f.systemctl("daemon-reload").status).toBe(0);
      }
      const source = readFileSync(owner, "utf8");
      const body = source.split("<<'SUPERVISOR'\n")[1]?.split("\nSUPERVISOR")[0];
      expect(body).toBeDefined();
      const signals: Array<string | number> = [];
      const handlers = new Map<string, () => void>();
      const timers = new Map<number, { at: number; callback: () => void }>();
      let now = 0;
      let serial = 0;
      let alive = true;
      const exit = vi.fn();
      const fs = {
        openSync: () => 1,
        closeSync: () => {},
        writeFileSync: () => {},
        renameSync: () => {},
        writeSync: () => {},
      };
      vm.runInNewContext(body!.replace(/^import .*;\n/gm, ""), {
        fs,
        spawn: () => ({ pid: 42, on: () => {}, once: () => {} }),
        execFileSync: (_binary: string, args: string[]) => {
          expect(args).toEqual([join(f.home, "bin/systemd-fixture.mjs"), "stop-timeout-ms"]);
          const result = f.manager("stop-timeout-ms");
          expect(result.status, result.stderr).toBe(0);
          return result.stdout;
        },
        process: {
          pid: 43,
          execPath: process.execPath,
          env: {
            OPENCLAW_SYSTEMCTL_SHIM_MANAGER_SCRIPT: join(f.home, "bin/systemd-fixture.mjs"),
            OPENCLAW_SYSTEMCTL_SHIM_EXEC_START: "/usr/bin/true",
            OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG: "/fixture/log",
            OPENCLAW_SYSTEMCTL_SHIM_MANAGER_ENV: "{}",
          },
          hrtime: { bigint: () => 1n },
          exit,
          on: (signal: string, handler: () => void) => handlers.set(signal, handler),
          kill: (pid: number, signal: string | number) => {
            expect(pid).toBe(-42);
            if (signal === 0) {
              if (!alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
            } else signals.push(signal);
          },
        },
        setTimeout: (callback: () => void, delay: number) => {
          const id = ++serial;
          timers.set(id, { at: now + delay, callback });
          return id;
        },
        clearTimeout: (id: number) => timers.delete(id),
      });
      const advance = (until: number) => {
        while (true) {
          const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
          if (!next || next[1].at > until) break;
          now = next[1].at;
          timers.delete(next[0]);
          next[1].callback();
        }
        now = until;
      };
      if (seconds === 330) {
        // Repair the manager policy after supervisor launch, before its stop.
        writeFileSync(f.unit, "[Service]\nExecStart=/usr/bin/true\nTimeoutStopSec=330\n");
        expect(f.systemctl("daemon-reload").status).toBe(0);
        writeFileSync(f.unit, "[Service]\nExecStart=/usr/bin/true\nTimeoutStopSec=1\n");
      }
      handlers.get(seconds === 30 ? "SIGINT" : "SIGTERM")!();
      const deadline = seconds === "infinity" ? 400_000 : seconds * 1_000;
      advance(deadline - 1);
      expect(signals).toEqual(["SIGTERM"]);
      expect(exit).not.toHaveBeenCalled();
      advance(deadline);
      expect(signals).toEqual(seconds === "infinity" ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"]);
      // Sending SIGKILL is not extinction; settlement waits for the group observer.
      expect(exit).not.toHaveBeenCalled();
      alive = false;
      advance(deadline + 25);
      expect(exit).toHaveBeenCalledExactlyOnceWith(0);
      expect(timers.size).toBe(0);

      const stop = source.match(/stop_gateway\(\) \{[\s\S]*?\n\}/)?.[0];
      expect(stop).toBeDefined();
      const pidFile = join(f.home, "pid");
      writeFileSync(pidFile, "999999\n");
      const outer = spawnSync(
        "bash",
        [
          "-c",
          [
            "set -euo pipefail",
            stop,
            "pid_file=$1; supervisor_script=$1.supervisor; manager_script=$2",
            "ticks=0; kill() { :; }; sleep() { ticks=$((ticks + 1)); }",
            "is_running() { [ $ticks -lt 4000 ]; }",
            "status=0; stop_gateway || status=$?; printf '%s' $ticks; exit $status",
          ].join("\n"),
          "fixture",
          pidFile,
          join(f.home, "bin/systemd-fixture.mjs"),
        ],
        { env: f.env, encoding: "utf8" },
      );
      expect(outer.status, outer.stderr).toBe(seconds === "infinity" ? 0 : 1);
      if (seconds !== "infinity") {
        expect(outer.stderr).toContain("retaining process custody");
        expect(existsSync(pidFile)).toBe(true);
      }
      expect(Number(outer.stdout)).toBe(
        seconds === "infinity" ? 4000 : (seconds * 1_000 + 5_000) / 100,
      );
    },
  );

  it.each(["signal", "child-close"])(
    "retains custody when the policy read fails during %s drain",
    (entry) => {
      const source = readFileSync(owner, "utf8");
      const body = source.split("<<'SUPERVISOR'\n")[1]?.split("\nSUPERVISOR")[0];
      expect(body).toBeDefined();
      const handlers = new Map<string, () => void>();
      let closeChild: ((code: number, signal: string | null) => void) | undefined;
      const timers: Array<() => void> = [];
      const signals: Array<string | number> = [];
      let alive = true;
      const exit = vi.fn();
      const log = vi.fn();
      const files = new Map<string, string>();
      const spawn = vi.fn(() => ({
        pid: 42,
        on: () => {},
        once: (_event: string, callback: (code: number, signal: string | null) => void) => {
          closeChild = callback;
        },
      }));
      vm.runInNewContext(body!.replace(/^import .*;\n/gm, ""), {
        fs: {
          openSync: () => 1,
          closeSync: () => {},
          writeSync: log,
          writeFileSync: (file: string, contents: string) => files.set(file, contents),
          renameSync: (from: string, to: string) => files.set(to, files.get(from)!),
        },
        spawn,
        execFileSync: () => {
          throw new Error("policy read failed");
        },
        process: {
          pid: 43,
          execPath: process.execPath,
          cwd: () => "/fixture",
          env: {
            OPENCLAW_SYSTEMCTL_SHIM_MANAGER_SCRIPT: "/fixture/manager.mjs",
            OPENCLAW_SYSTEMCTL_SHIM_EXEC_START: "/usr/bin/true",
            OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG: "/fixture/log",
            OPENCLAW_SYSTEMCTL_SHIM_MANAGER_ENV: "{}",
          },
          hrtime: { bigint: () => 1n },
          exit,
          on: (signal: string, callback: () => void) => handlers.set(signal, callback),
          kill: (pid: number, signal: string | number) => {
            expect(pid).toBe(-42);
            if (signal === 0) {
              if (!alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
            } else signals.push(signal);
          },
        },
        setTimeout: (callback: () => void) => {
          timers.push(callback);
          return timers.length;
        },
        clearTimeout: () => {},
      });
      const beginDrain = () =>
        entry === "signal" ? handlers.get("SIGTERM")!() : closeChild!(0, null);
      expect(beginDrain).not.toThrow();
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(log.mock.calls.flat().join(" ")).toContain("stop policy read failed");
      expect(exit).not.toHaveBeenCalled();
      expect(JSON.parse(files.get("/fixture/log.runtime.json")!)).toMatchObject({
        groupPid: 42,
        supervisorPid: 43,
      });
      // A failed forced kill cannot turn into a clean exit or restart.
      timers.shift()!();
      expect(exit).not.toHaveBeenCalled();
      alive = false;
      timers.shift()!();
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(spawn).toHaveBeenCalledOnce();
      const runtime = JSON.parse(files.get("/fixture/log.runtime.json")!);
      expect(runtime).toMatchObject({ pid: 0, groupPid: 0, supervisorPid: 0, stopFailed: true });
      const f = fixture();
      writeFileSync(
        join(f.home, "bin/systemctl-shim-gateway.log.runtime.json"),
        JSON.stringify(runtime),
      );
      const stopped = f.systemctl("stop", "openclaw-gateway.service");
      expect(stopped.status).toBe(1);
      expect(stopped.stderr).toContain("stop policy read failed");
    },
  );
});
