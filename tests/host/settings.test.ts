import { describe, expect, test } from "bun:test";
import { PI_ATTRIBUTION } from "@earendil-works/pi-ai";
import { SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import {
  createHarnessSettings,
  harnessIdentity,
} from "../../src/host/harness-setup.js";

import { readLimits, readVerifySettings } from "../../src/host/settings.js";

describe("verification settings", () => {
  test("scrubs by default and validates environment overrides", () => {
    expect(readVerifySettings({})).toEqual({
      mode: "scrub",
      passthrough: [],
      errors: [],
    });
    expect(
      readVerifySettings({
        piAgents: {
          verifyEnv: "minimal",
          verifyEnvPassthrough: ["CI_TOKEN", "CI_TOKEN"],
        },
      }),
    ).toEqual({ mode: "minimal", passthrough: ["CI_TOKEN"], errors: [] });
    const invalid = readVerifySettings({
      piAgents: { verifyEnv: "unsafe", verifyEnvPassthrough: ["X=Y"] },
    });
    expect(invalid.mode).toBe("scrub");
    expect(invalid.passthrough).toEqual([]);
    expect(invalid.errors).toHaveLength(2);
  });
  test("environment policy comes from global settings, resource limits remain merged", () => {
    const settings = SettingsManager.fromStorage({
      withLock(scope, read) {
        read(
          JSON.stringify({
            piAgents:
              scope === "global"
                ? { verifyEnv: "minimal", maxSolvers: 4 }
                : { verifyEnv: "inherit", maxSolvers: 20 },
          }),
        );
      },
    });
    expect(readVerifySettings(settings.getGlobalSettings()).mode).toBe(
      "minimal",
    );
    expect(readLimits(settings.getSettings()).limits.maxSolvers).toBe(20);
    expect(
      readVerifySettings({ piAgents: { verifyEnv: "inherit" } }).mode,
    ).toBe("inherit");
  });
});

describe("harness settings", () => {
  test("agents compact with Pi's per-model token settings", () => {
    const settings = createHarnessSettings(
      SettingsManager.inMemory({
        compaction: {
          reserveTokens: 1000,
          modelOverrides: {
            "faux/small": { reserveTokens: 100, keepRecentTokens: 50 },
            "faux/broken": { reserveTokens: -1 },
          },
        },
      } as never),
    );
    expect(settings.compaction).toMatchObject({
      reserveTokens: 1000,
      modelOverrides: {
        "faux/small": { reserveTokens: 100, keepRecentTokens: 50 },
      },
    });
    expect(settings.compaction?.modelOverrides).not.toHaveProperty(
      "faux/broken",
    );
  });

  test("agents attribute requests to Pi only while telemetry is enabled", () => {
    const enabled = SettingsManager.inMemory({ enableInstallTelemetry: true });
    const disabled = SettingsManager.inMemory({
      enableInstallTelemetry: false,
    });
    expect(harnessIdentity(enabled, undefined)).toEqual({
      userAgent: "detailed",
      version: VERSION,
      attribution: PI_ATTRIBUTION,
    });
    expect(harnessIdentity(disabled, undefined).attribution).toBeNull();
    // The environment overrides the setting either way.
    expect(harnessIdentity(disabled, "Yes").attribution).toEqual(
      PI_ATTRIBUTION,
    );
    expect(harnessIdentity(enabled, "0").attribution).toBeNull();
  });
});
