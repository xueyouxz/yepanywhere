/**
 * YA-private module environment: registered `YEP_<MODULE>_` prefixes.
 *
 * These carry secrets/config that belong to a YA subsystem, not to any agent
 * CLI. On server load they are harvested into a private in-process store and
 * **deleted from `process.env`**, so they can never ride the ambient
 * environment into a spawned child process (e.g. a provider CLI that would
 * otherwise honor a same-named key — see the billing footgun in
 * topics/cost-efficiency.md). A YA subsystem reads its value via
 * `getModuleEnv(module)[NAME]` instead of `process.env`.
 *
 * Ordinary `YEP_*` variables are not private automatically. Each private
 * module prefix is registered explicitly because the canonical naming scheme
 * uses one underscore for both module-scoped and ordinary config names.
 */

const store = new Map<string, Record<string, string>>();
const MODULE_PREFIXES = new Map([["YEP_STT_", "stt"]]);

/**
 * Harvest and remove registered private module vars from `env`. Idempotent on
 * a given env object: harvested keys are deleted, so a second pass finds
 * nothing. Call early in server startup (loadConfig does) so stripping happens
 * before any child process can be spawned.
 */
export function harvestYaModuleEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(env)) {
    const prefixEntry = Array.from(MODULE_PREFIXES).find(([prefix]) =>
      key.startsWith(prefix),
    );
    if (!prefixEntry) continue;
    const [prefix, module] = prefixEntry;
    const name = key.slice(prefix.length);
    const value = env[key];
    if (name.length > 0 && value !== undefined) {
      const existing = store.get(module) ?? {};
      existing[name] = value;
      store.set(module, existing);
    }
    delete env[key];
  }
}

/** Values for a module's harvested private vars (empty if none). */
export function getModuleEnv(module: string): Record<string, string> {
  harvestYaModuleEnv();
  return store.get(module) ?? {};
}
