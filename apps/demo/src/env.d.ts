/** Vite's `?inline` imports: the file's text (vm-console.ts takes xterm.js's stylesheet this way). */
declare module '*.css?inline' {
  const text: string;
  export default text;
}
