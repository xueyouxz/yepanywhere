/**
 * YA-private module environment: `YA_<module>__<NAME>` variables.
 *
 * These carry secrets/config that belong to a YA subsystem, not to any agent
 * CLI. On server load they are harvested into a private in-process store and
 * **deleted from `process.env`**, so they can never ride the ambient
 * environment into a spawned child process (e.g. a provider CLI that would
 * otherwise honor a same-named key — see the billing footgun in
 * topics/cost-efficiency.md). A YA subsystem reads its value via
 * `getModuleEnv(module)[NAME]` instead of `process.env`.
 *
 * Naming: the `YA_` prefix marks "consume and strip"; the module and name are
 * split on the **first** `__`, so the name half may itself contain `__`
 * (e.g. `YA_stt__XAI_API_KEY` → module `stt`, name `XAI_API_KEY`).
 */

const store = new Map<string, Record<string, string>>();

/**
 * Harvest and remove every `YA_<module>__<NAME>` var from `env`. Idempotent on
 * a given env object: harvested keys are deleted, so a second pass finds
 * nothing. Call early in server startup (loadConfig does) so stripping happens
 * before any child process can be spawned.
 */
export function harvestYaModuleEnv(env: NodeJS.ProcessEnv = process.env): void {
  const pattern = /^YA_(.+?)__(.+)$/; // split on the first "__"
  for (const key of Object.keys(env)) {
    const match = pattern.exec(key);
    if (!match) continue;
    const module = match[1];
    const name = match[2];
    const value = env[key];
    if (module !== undefined && name !== undefined && value !== undefined) {
      const existing = store.get(module) ?? {};
      existing[name] = value;
      store.set(module, existing);
    }
    delete env[key];
  }
}

/** Values for a module's harvested `YA_<module>__*` vars (empty if none). */
export function getModuleEnv(module: string): Record<string, string> {
  harvestYaModuleEnv();
  return store.get(module) ?? {};
}
