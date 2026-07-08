// Vite serves imported assets as URLs; the brand mark is the only one.
declare module "*.svg" {
    const url: string;
    export default url;
}
