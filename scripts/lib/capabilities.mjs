export const BASE_CAPABILITIES = Object.freeze([
  "agent.use",
  "research.use",
  "ssh.manage-own",
]);

export function capabilitiesForIdentity(user, options = {}) {
  const normalize = (value) => String(value || "").trim().toLowerCase();
  const adminUsername = normalize(options.adminUsername || "admin");
  const isAdmin = user?.role === "admin" || normalize(user?.username) === adminUsername;
  const capabilities = new Set(BASE_CAPABILITIES);
  if (isAdmin) {
    capabilities.add("ssh.import-system-config");
    capabilities.add("public.read");
    capabilities.add("public.manage");
    if (options.nodeEnv !== "production") capabilities.add("developer.simulate-drop");
  }
  return [...capabilities];
}

export function identityHasCapability(user, capability, options = {}) {
  return capabilitiesForIdentity(user, options).includes(capability);
}
