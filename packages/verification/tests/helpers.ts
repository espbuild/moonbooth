import { buildPackage, type BuiltPackage, type ManifestInput } from "@moonbooth/protocol";

export function manifestInput(overrides: Partial<ManifestInput> = {}): ManifestInput {
  return {
    act_version: "0.1",
    capability: {
      id: "sample-capability",
      name: "Sample Capability",
      version: "1.0.0",
      description: "A sample capability used in verification tests.",
    },
    artifact: { format: "agent-skills", entrypoint: "SKILL.md" },
    requirements: { tools: [], configuration: [] },
    requested_permissions: {
      network: false,
      filesystem_write: false,
      external_side_effects: false,
    },
    verification: { test_manifest: "tests/manifest.json" },
    ...overrides,
  };
}

export const goodFiles: Record<string, string> = {
  "SKILL.md": "# Sample\n\nDo the sample task and report the result.\n",
  "tests/manifest.json": '{"suite_id":"sample","version":"1.0.0"}\n',
  "references/notes.md": "Some notes.\n",
};

export function goodPackage(overrides: Partial<ManifestInput> = {}): BuiltPackage {
  return buildPackage({ manifest: manifestInput(overrides), files: goodFiles });
}
