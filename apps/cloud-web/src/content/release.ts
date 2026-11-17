/**
 * The program's current release, for the public pages (Home, Requirements, FAQ). Keep it the same as
 * the first entry of the website's changelog (pages/site/Changelog.tsx; tested) and the version in
 * the root package.json.
 */
export const CURRENT_VERSION = "0.13.1";

/** The installer's file name for a version, as the Windows workflow names it. */
export const installerName = (version = CURRENT_VERSION) => `MatchFrameEsports-Setup-${version}.exe`;
