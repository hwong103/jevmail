// Vite's ?raw import suffix, used to inline migration SQL in the test bundle.
declare module "*?raw" {
  const content: string;
  export default content;
}
