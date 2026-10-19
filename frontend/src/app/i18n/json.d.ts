/**
 * 2-8 (i18n): ambient declaration so spec/helper code can import the
 * translation JSON payloads (`assets/i18n/el.json` / `en.json`) without
 * enabling `resolveJsonModule` project-wide.
 */
declare module '*.json' {
  const value: Record<string, unknown>;
  export default value;
}
