// Per-repo values for the shared scripts/test-package.mjs smoke test.
export default {
  // Every packed tar entry must match; anything else fails before installation.
  files:
    /^package\/(?:index\.ts|src\/[\w-]+\.ts|docs\/[\w-]+\.md|docs\/images\/[\w-]+\.svg|package\.json|README\.md|ARCHITECTURE\.md|CHANGELOG\.md|LICENSE|THIRD_PARTY_NOTICES\.md)$/,
  requiredFiles: ["README.md", "CHANGELOG.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
  tools: ["delegate_task", "delegate_coordinate", "subagent"],
  commands: ["subagent-hub", "subagent-profiles", "subagent-stop"],
  // Optional repo-specific behavior checks: async verify({ extension, pkg, installed, root, host }).
};
