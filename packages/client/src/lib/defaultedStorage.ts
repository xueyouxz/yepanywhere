export const CLIENT_STORAGE_DEFAULT = "default" as const;

export type ClientStorageDefault = typeof CLIENT_STORAGE_DEFAULT;
export type DefaultedValue<T> = T | ClientStorageDefault;
export type DefaultedBoolean = boolean | ClientStorageDefault;
export type DefaultedBooleanRecord<Key extends string> = Partial<
  Record<Key, DefaultedBoolean>
>;

export function isClientStorageDefault(
  value: unknown,
): value is ClientStorageDefault {
  return value === CLIENT_STORAGE_DEFAULT;
}

export function resolveDefaultedValue<T>(
  stored: DefaultedValue<T>,
  defaultValue: T,
): T {
  return isClientStorageDefault(stored) ? defaultValue : stored;
}

export function normalizeDefaultedBooleanRecord<Key extends string>(
  value: unknown,
  keys: readonly Key[],
): DefaultedBooleanRecord<Key> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const input = value as Partial<Record<Key, unknown>>;
  const normalized: DefaultedBooleanRecord<Key> = {};
  for (const key of keys) {
    const stored = input[key];
    if (typeof stored === "boolean") {
      normalized[key] = stored;
    } else if (stored === CLIENT_STORAGE_DEFAULT) {
      normalized[key] = CLIENT_STORAGE_DEFAULT;
    }
  }
  return normalized;
}

export function resolveDefaultedBooleanRecord<Key extends string>(
  stored: DefaultedBooleanRecord<Key>,
  defaults: Record<Key, boolean>,
  keys: readonly Key[],
): Record<Key, boolean> {
  const resolved = { ...defaults };
  for (const key of keys) {
    const storedValue = stored[key];
    if (typeof storedValue === "boolean") {
      resolved[key] = storedValue;
    }
  }
  return resolved;
}

export function setDefaultedBooleanRecordValue<Key extends string>(
  stored: DefaultedBooleanRecord<Key>,
  key: Key,
  value: DefaultedBoolean,
): DefaultedBooleanRecord<Key> {
  const next = { ...stored };
  if (value === CLIENT_STORAGE_DEFAULT) {
    delete next[key];
  } else {
    next[key] = value;
  }
  return next;
}
