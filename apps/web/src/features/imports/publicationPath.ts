/** Library-relative directory, matching the server and publication worker boundary. */
export function validPublicationLogicalPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4096 &&
    !value.startsWith('/') &&
    !/^[A-Za-z]:/.test(value) &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    value.split('/').every((part) => part.trim().length > 0 && part !== '.' && part !== '..')
  );
}
