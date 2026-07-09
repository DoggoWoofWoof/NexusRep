import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NexusRep — AI Rep Studio",
  description: "Train and launch a compliant AI rep for the right HCPs.",
};

// Import map for the optional "Live 3D avatar" mode (TalkingHead + HeadTTS),
// loaded from CDN at runtime via `import(/* webpackIgnore */ ...)`. Rendered into
// the initial SSR HTML so the browser registers it before any dynamic module load.
// None of this is fetched unless the user turns on Live 3D — the app is unaffected otherwise.
const IMPORT_MAP = {
  imports: {
    three: "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js/+esm",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/",
    talkinghead: "https://cdn.jsdelivr.net/gh/met4citizen/TalkingHead@1.7/modules/talkinghead.mjs",
    headtts: "https://cdn.jsdelivr.net/npm/@met4citizen/headtts@1.3/+esm",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Full DocNexus design system (tokens + fonts) served from /public. */}
        <link rel="stylesheet" href="/colors_and_type.css" />
      </head>
      <body>
        {/* Import map first in the document so it registers before any module load. */}
        <script type="importmap" dangerouslySetInnerHTML={{ __html: JSON.stringify(IMPORT_MAP) }} />
        {children}
      </body>
    </html>
  );
}
