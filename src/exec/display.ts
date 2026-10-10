import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export interface DisplayHandle {
  display?: string;
  mode: "current" | "xvfb" | "none";
  env: Record<string, string>;
  note: string;
  stop(): void;
}

function which(cmd: string): boolean {
  return spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;
}

const LIB_DIRS = ["/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/usr/lib64", "/usr/lib"];

/**
 * Minecraft 26.x opens its window through SDL3, and SDL's GLX path finds no matching visual on Xvfb + Mesa.
 * SDL's EGL path works, so on Xvfb FFN forces EGL whenever a Mesa EGL is available: the system one, or one
 * unpacked under $FFN_EGL_DIR (a directory containing usr/lib/<triplet>/libEGL.so.1, for machines without root).
 * GLFW-based versions (1.20.x/1.21.x) ignore these variables.
 */
export function eglEnv(): { env: Record<string, string>; note: string } {
  const custom = process.env.FFN_EGL_DIR;
  if (custom) {
    const lib = LIB_DIRS.map((d) => path.join(custom, d)).find((d) => existsSync(path.join(d, "libEGL.so.1")));
    if (lib) {
      const vendorDir = path.join(custom, "usr/share/glvnd/egl_vendor.d");
      const vendors = existsSync(vendorDir) ? readdirSync(vendorDir).filter((f) => f.endsWith(".json")).map((f) => path.join(vendorDir, f)) : [];
      return {
        env: {
          SDL_VIDEO_FORCE_EGL: "1",
          LD_LIBRARY_PATH: [lib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
          ...(vendors.length ? { __EGL_VENDOR_LIBRARY_FILENAMES: vendors.join(":") } : {}),
        },
        note: ` SDL forced to EGL using ${lib}.`,
      };
    }
  }
  if (LIB_DIRS.some((d) => existsSync(path.join(d, "libEGL.so.1")))) return { env: { SDL_VIDEO_FORCE_EGL: "1" }, note: " SDL forced to EGL." };
  return {
    env: {},
    note: " No libEGL found: Minecraft 26.x (SDL3) will likely fail with \"Couldn't find matching GLX visual\" on Xvfb. Install libegl1 + libegl-mesa0, or set FFN_EGL_DIR to an unpacked copy.",
  };
}

/**
 * Provide a display for the game client.
 * auto: use the current display when one exists (or on macOS/Windows), else start Xvfb.
 */
export async function acquireDisplay(mode: "auto" | "xvfb" | "current"): Promise<DisplayHandle> {
  const linux = process.platform === "linux";
  const current = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
  if (mode === "current" || (mode === "auto" && (!linux || current))) {
    return {
      mode: "current",
      display: process.env.DISPLAY,
      env: {},
      note: linux ? `Using the current display ${current ?? "(none set!)"}.` : "Using the desktop session.",
      stop() {},
    };
  }
  if (!linux) throw new Error("Xvfb is only available on Linux; use display=current.");
  if (!which("Xvfb")) {
    throw new Error("No display available and Xvfb is not installed. Install it (e.g. `sudo apt install xvfb` plus Mesa `libgl1-mesa-dri`) or run with a real display (display=current).");
  }
  let n = 90;
  while (existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`)) n++;
  const display = `:${n}`;
  const proc: ChildProcess = spawn("Xvfb", [display, "-screen", "0", "1280x720x24", "+extension", "GLX", "+render", "-noreset", "-nolisten", "tcp"], { stdio: "ignore", detached: true });
  const deadline = Date.now() + 8000;
  while (!existsSync(`/tmp/.X11-unix/X${n}`)) {
    if (proc.exitCode !== null) throw new Error(`Xvfb exited immediately (code ${proc.exitCode}).`);
    if (Date.now() > deadline) {
      proc.kill("SIGKILL");
      throw new Error("Xvfb did not start within 8s.");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const egl = eglEnv();
  return {
    mode: "xvfb",
    display,
    env: { DISPLAY: display, LIBGL_ALWAYS_SOFTWARE: "1", ...egl.env },
    note: `Started Xvfb on ${display} (software OpenGL via Mesa; rendering is slow but sufficient for smoke tests).${egl.note}`,
    stop() {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* gone */
      }
    },
  };
}
