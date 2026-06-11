// Webpack resolves these via `asset/resource` → the imported value is the URL string.
declare module '*.svg' {
  const url: string;
  export default url;
}
