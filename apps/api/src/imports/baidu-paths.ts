/** Account reads and managed staging/deletion are deliberately different scopes. */
export function isCanonicalBaiduPath(value: string, allowRoot = true): boolean {
  return (
    value.startsWith('/') &&
    value.length <= 4096 &&
    !value.includes('\\') &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 0x20) &&
    (value === '/'
      ? allowRoot
      : !value.endsWith('/') &&
        value
          .split('/')
          .slice(1)
          .every((part) => part !== '' && part !== '.' && part !== '..'))
  );
}
export function isManagedBaiduMutationPath(value: string): boolean {
  return isCanonicalBaiduPath(value, false) && value.startsWith('/apps/bdpan/');
}
