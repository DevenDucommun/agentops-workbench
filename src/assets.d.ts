// Text-imported static assets (Bun `with { type: "text" }`). `*.html` is already
// declared by bun-types; declare the CSS/JS asset imports here so tsc resolves
// them. At runtime with `type: "text"` these are strings (cast at the use site).
declare module "*.css" {
  const content: string;
  export default content;
}
declare module "*.client.js" {
  const content: string;
  export default content;
}
