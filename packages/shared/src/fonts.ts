/** The reserved system family never triggers a network font request. */
export const SYSTEM_FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
export function isSystemFont(value: string): boolean {
  return ['system', 'system-ui'].includes(value.trim().toLowerCase());
}
export function fontFamilyCss(value: string): string {
  if (isSystemFont(value)) return SYSTEM_FONT_STACK;
  // Family names are data, never CSS declarations or HTML.
  return `'${value.replace(/[\\'\r\n<>;{}]/g, '')}'`;
}
