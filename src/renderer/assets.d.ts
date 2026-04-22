// Vite static asset imports — lets TypeScript understand image imports as URL strings
declare module '*.png' {
  const src: string;
  export default src;
}
declare module '*.webp' {
  const src: string;
  export default src;
}
declare module '*.jpg' {
  const src: string;
  export default src;
}
