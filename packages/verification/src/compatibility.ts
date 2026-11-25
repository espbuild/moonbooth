import type { ActManifest } from "@moonbooth/protocol";
import { DENIED_TOOLS } from "./policy.js";
import type { CompatibilityResult, EnvironmentProfile } from "./types.js";

/**
 * Compatibility assessment. Compares the manifest requirements and
 * requested permissions against a recipient environment profile.
 * An absent or empty profile gives outcome "unknown", never
 * "compatible": there is nothing to compare against.
 */
export function assessCompatibility(input: {
  manifest: ActManifest | null;
  profile?: EnvironmentProfile | null;
}): CompatibilityResult {
  const base = {
    missingTools: [] as string[],
    ungrantedPermissions: [] as string[],
    missingConfiguration: [] as string[],
    adaptations: [] as string[],
  };
  const profile = input.profile;
  if (
    !profile ||
    !profile.adapter_id ||
    (profile.available_tools.length === 0 &&
      Object.keys(profile.granted_permissions).length === 0 &&
      !profile.notes)
  ) {
    return {
      ...base,
      outcome: "unknown",
      label: "INSUFFICIENT_EVIDENCE",
      reasons: [
        "No recipient environment profile was supplied, so tool, permission, and configuration requirements were not compared against any environment.",
      ],
    };
  }
  if (!input.manifest) {
    return {
      ...base,
      outcome: "unknown",
      label: "INSUFFICIENT_EVIDENCE",
      reasons: ["The manifest did not validate, so its requirements could not be read."],
    };
  }

  const manifest = input.manifest;
  const reasons: string[] = [];

  const denied = manifest.requirements.tools.filter((t) =>
    (DENIED_TOOLS as readonly string[]).includes(t.toLowerCase()),
  );
  const missingTools = manifest.requirements.tools.filter(
    (t) => !profile.available_tools.includes(t),
  );
  const missingConfiguration = manifest.requirements.configuration
    .filter((c) => c.required && !(profile.configuration ?? []).includes(c.name))
    .map((c) => c.name);
  const ungrantedPermissions = Object.entries(manifest.requested_permissions)
    .filter(([name, wanted]) => wanted && profile.granted_permissions[name] !== true)
    .map(([name]) => name);

  for (const t of denied) {
    reasons.push(`The capability requires the tool "${t}", which the policy denylist bars in any environment.`);
  }
  for (const t of missingTools) {
    reasons.push(`The tool "${t}" is required by the manifest and is not in the profile's available tools.`);
  }
  for (const name of missingConfiguration) {
    reasons.push(`The configuration entry "${name}" is required by the manifest and the profile does not list it as supplied.`);
  }
  const adaptations: string[] = [];
  for (const name of ungrantedPermissions) {
    adaptations.push(
      `The package requests the "${name}" permission and the profile does not grant it. The capability must run without that permission, or the recipient must grant it before adoption.`,
    );
    reasons.push(`Requested permission "${name}" is not granted by the profile.`);
  }

  let outcome: CompatibilityResult["outcome"];
  let label: CompatibilityResult["label"];
  if (denied.length > 0) {
    outcome = "unsupported";
    label = "FAILED";
  } else if (missingTools.length > 0 || missingConfiguration.length > 0) {
    outcome = "missing_dependencies";
    label = "FAILED";
  } else if (ungrantedPermissions.length > 0) {
    outcome = "compatible_with_adaptation";
    label = "TESTED";
  } else {
    outcome = "compatible";
    label = "TESTED";
    reasons.push(
      "Every tool, required configuration entry, and requested permission in the manifest is present in the profile.",
    );
  }

  return {
    outcome,
    label,
    reasons,
    missingTools,
    ungrantedPermissions,
    missingConfiguration,
    adaptations,
  };
}
